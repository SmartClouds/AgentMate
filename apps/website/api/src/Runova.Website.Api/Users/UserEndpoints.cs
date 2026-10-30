using System.Net.Mail;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Runova.Website.Api.Audit;
using Runova.Website.Api.Http;
using Runova.Website.Api.Identity;
using Runova.Website.Api.Paging;
using Runova.Website.Api.Problems;
using Runova.Website.Core.Audit;
using Runova.Website.Core.Identity;
using Runova.Website.Core.Paging;
using Runova.Website.Core.Problems;
using Runova.Website.Core.Users;
using Runova.Website.Data;
using Runova.Website.Data.Identity;

namespace Runova.Website.Api.Users;

public sealed record InviteUserRequest(string? Email, string? DisplayName, IReadOnlyList<string>? Roles);

/// <summary>The fields a merge patch of a user may hold. The handler reads the JSON itself.</summary>
public sealed record UserPatchRequest(string? DisplayName, IReadOnlyList<string>? Roles, bool? Disabled);

/// <summary>
/// Staff accounts, for Admins only. No route ever leaves the site without an Admin who can sign
/// in, and every change writes an audit entry in the same transaction.
/// </summary>
internal static class UserEndpoints
{
    private const int MaxDisplayName = 100;
    private const int MaxEmail = 256;
    private const string RolesMessage = "Roles are Admin and Editor.";

    // Serializes the changes that could remove the last Admin, so two of them can not each see
    // the other as the one that remains.
    private const long LastAdminLock = 41_004;

    public static IServiceCollection AddWebsiteUsers(this IServiceCollection services) =>
        services.AddHttpContextAccessor().AddScoped<SetupLinks>().AddScoped<AuditLog>();

    public static RouteGroupBuilder MapUsers(this RouteGroupBuilder api)
    {
        var users = api.MapGroup("/users").RequireAuthorization(Policies.Admin);
        users.MapGet("", ListAsync);
        users.MapPost("", InviteAsync);
        users.MapGet("/{id:long}", GetAsync);
        users.MapPatch("/{id:long}", PatchAsync).Accepts<UserPatchRequest>("application/merge-patch+json");
        users.MapDelete("/{id:long}", DeleteAsync);
        users.MapPost("/{id:long}/password-resets", ResetPasswordAsync);
        users.MapDelete("/{id:long}/two-factor", ResetTwoFactorAsync);
        users.MapPost("/{id:long}/invitations", InviteAgainAsync);
        return api;
    }

    private static async Task<Results<Ok<Page<UserDto>>, ValidationProblem>> ListAsync(
        int? page, int? pageSize, string? q, string? role, bool? disabled, AppDbContext db, TimeProvider time, HttpContext http)
    {
        var request = PageRequest.Parse(page, pageSize, out var errors);
        if (role is not null && !Roles.All.Contains(role))
        {
            errors["role"] = [RolesMessage];
        }

        if (errors.Count > 0)
        {
            return ApiProblems.Invalid(errors);
        }

        IQueryable<AppUser> query = db.Users;
        if (!string.IsNullOrWhiteSpace(q))
        {
            var pattern = $"%{EscapeLike(q.Trim())}%";
            query = query.Where(u => EF.Functions.ILike(u.Email!, pattern, @"\") || EF.Functions.ILike(u.DisplayName, pattern, @"\"));
        }

        if (role is not null)
        {
            var roleId = await db.Roles.Where(r => r.Name == role).Select(r => r.Id).SingleAsync();
            query = query.Where(u => db.UserRoles.Any(ur => ur.UserId == u.Id && ur.RoleId == roleId));
        }

        if (disabled is { } wanted)
        {
            query = wanted ? query.Where(u => u.DisabledAt != null) : query.Where(u => u.DisabledAt == null);
        }

        var total = await query.CountAsync();
        var users = await query.OrderBy(u => u.Id).Skip(request.Skip).Take(request.Size).ToListAsync();
        var ids = users.Select(u => u.Id).ToList();
        var roles = (await (from ur in db.UserRoles
                            join r in db.Roles on ur.RoleId equals r.Id
                            where ids.Contains(ur.UserId)
                            select new { ur.UserId, r.Name }).ToListAsync())
            .ToLookup(x => x.UserId, x => x.Name!);

        var result = Page.Of([.. users.Select(u => UserViews.ToDto(u, roles[u.Id], time))], request, total);
        PageLinks.Set(http, result);
        return TypedResults.Ok(result);
    }

    private static async Task<Results<Created<UserInvitedDto>, ValidationProblem, ProblemHttpResult>> InviteAsync(
        InviteUserRequest request,
        UserManager<AppUser> users,
        AppDbContext db,
        SetupLinks links,
        AuditLog audit,
        TimeProvider time)
    {
        var errors = new Dictionary<string, string[]>();
        var email = request.Email?.Trim() ?? "";
        if (email.Length > MaxEmail || !MailAddress.TryCreate(email, out var address) || address.Address != email)
        {
            errors["email"] = ["Enter an email address."];
        }

        AddIfInvalid(errors, "displayName", DisplayNameError(request.DisplayName));
        AddIfInvalid(errors, "roles", RolesError(request.Roles));
        if (errors.Count > 0)
        {
            return ApiProblems.Invalid(errors);
        }

        if (await users.FindByEmailAsync(email) is not null)
        {
            return EmailTaken();
        }

        var user = new AppUser { UserName = email, Email = email, DisplayName = request.DisplayName!.Trim(), CreatedAt = time.GetUtcNow() };
        var roles = Roles.All.Intersect(request.Roles!).ToList();

        await using var transaction = await db.Database.BeginTransactionAsync();
        var created = await users.CreateAsync(user);
        if (!created.Succeeded)
        {
            return created.Errors.Any(e => e.Code is "DuplicateEmail" or "DuplicateUserName")
                ? EmailTaken()
                : ApiProblems.Invalid("email", string.Join(" ", created.Errors.Select(e => e.Description)));
        }

        Succeeded(await users.AddToRolesAsync(user, roles));
        var link = await links.IssueAsync(user, SetupLinkPurposes.Invitation);
        audit.Add(AuditActions.UserInvite, AuditTargetTypes.User, user.Id, new { email, displayName = user.DisplayName, roles });
        await db.SaveChangesAsync();
        await transaction.CommitAsync();

        return TypedResults.Created($"{ApiV1.Prefix}/users/{user.Id}", new UserInvitedDto(UserViews.ToDto(user, roles, time), link));
    }

    private static async Task<Results<Ok<UserDto>, ProblemHttpResult>> GetAsync(
        long id, UserManager<AppUser> users, TimeProvider time, HttpResponse response)
    {
        if (await FindAsync(users, id) is not { } user)
        {
            return NotFound();
        }

        Versions.SetETag(response, user.Version);
        return TypedResults.Ok(await users.ToDtoAsync(user, time));
    }

    /// <summary>
    /// A JSON merge patch of <c>displayName</c>, <c>roles</c> and <c>disabled</c>. Disabling ends
    /// the user's sessions, since it changes their security stamp.
    /// </summary>
    private static async Task<Results<Ok<UserDto>, ValidationProblem, ProblemHttpResult>> PatchAsync(
        long id,
        HttpContext http,
        UserManager<AppUser> users,
        AppDbContext db,
        AuditLog audit,
        TimeProvider time)
    {
        if (await FindAsync(users, id) is not { } user)
        {
            return NotFound();
        }

        if (Versions.CheckIfMatch(http.Request, user.Version) is { } precondition)
        {
            return precondition;
        }

        var (patch, errors) = await ReadPatchAsync(http.Request);
        if (errors.Count > 0)
        {
            return ApiProblems.Invalid(errors);
        }

        var currentRoles = await users.GetRolesAsync(user);
        var roles = patch.Roles ?? [.. currentRoles];
        var disabled = patch.Disabled ?? user.DisabledAt is not null;

        await using var transaction = await db.Database.BeginTransactionAsync();
        if (IsActiveAdmin(currentRoles, user.DisabledAt is not null)
            && !IsActiveAdmin(roles, disabled)
            && await IsLastActiveAdminAsync(db, user.Id))
        {
            return LastAdmin(patch.Disabled == true && roles.Contains(Roles.Admin) ? "disable" : "demote");
        }

        var changes = new Dictionary<string, object>();
        if (patch.DisplayName is { } displayName && displayName != user.DisplayName)
        {
            user.DisplayName = displayName;
            changes["displayName"] = displayName;
        }

        if (!roles.ToHashSet().SetEquals(currentRoles))
        {
            Succeeded(await users.RemoveFromRolesAsync(user, currentRoles.Except(roles)));
            Succeeded(await users.AddToRolesAsync(user, roles.Except(currentRoles)));
            changes["roles"] = Roles.All.Intersect(roles).ToList();
        }

        if (disabled != user.DisabledAt is not null)
        {
            user.DisabledAt = disabled ? time.GetUtcNow() : null;
            changes["disabled"] = disabled;
            Succeeded(await users.UpdateSecurityStampAsync(user));
        }
        else if (changes.ContainsKey("displayName"))
        {
            Succeeded(await users.UpdateAsync(user));
        }

        if (changes.Count > 0)
        {
            audit.Add(AuditActions.UserUpdate, AuditTargetTypes.User, user.Id, changes);
            await db.SaveChangesAsync();
        }

        await transaction.CommitAsync();
        Versions.SetETag(http.Response, user.Version);
        return TypedResults.Ok(UserViews.ToDto(user, roles, time));
    }

    private static async Task<Results<NoContent, ProblemHttpResult>> DeleteAsync(
        long id, HttpRequest request, UserManager<AppUser> users, AppDbContext db, AuditLog audit)
    {
        if (await FindAsync(users, id) is not { } user)
        {
            return NotFound();
        }

        if (Versions.CheckIfMatch(request, user.Version) is { } precondition)
        {
            return precondition;
        }

        await using var transaction = await db.Database.BeginTransactionAsync();
        if (IsActiveAdmin(await users.GetRolesAsync(user), user.DisabledAt is not null) && await IsLastActiveAdminAsync(db, user.Id))
        {
            return LastAdmin("delete");
        }

        audit.Add(AuditActions.UserDelete, AuditTargetTypes.User, user.Id, new { email = user.Email });
        Succeeded(await users.DeleteAsync(user));
        await transaction.CommitAsync();
        return TypedResults.NoContent();
    }

    /// <summary>A new one-time link to set a password with. The old password works until then.</summary>
    private static async Task<Results<Created<SetupLinkDto>, ProblemHttpResult>> ResetPasswordAsync(
        long id, UserManager<AppUser> users, AppDbContext db, SetupLinks links, AuditLog audit)
    {
        if (await FindAsync(users, id) is not { } user)
        {
            return NotFound();
        }

        var link = await links.IssueAsync(user, SetupLinkPurposes.PasswordReset);
        audit.Add(AuditActions.UserPasswordReset, AuditTargetTypes.User, user.Id);
        await db.SaveChangesAsync();
        return TypedResults.Created((string?)null, link);
    }

    /// <summary>Turns two-factor off and drops the key and recovery codes; the user's sessions end.</summary>
    private static async Task<Results<NoContent, ProblemHttpResult>> ResetTwoFactorAsync(
        long id, UserManager<AppUser> users, AppDbContext db, AuditLog audit)
    {
        if (await FindAsync(users, id) is not { } user)
        {
            return NotFound();
        }

        await using var transaction = await db.Database.BeginTransactionAsync();
        Succeeded(await users.SetTwoFactorEnabledAsync(user, false));
        await users.GenerateNewTwoFactorRecoveryCodesAsync(user, 0);
        user.LastTotpTimeStep = null;
        Succeeded(await users.ResetAuthenticatorKeyAsync(user));
        audit.Add(AuditActions.UserTwoFactorReset, AuditTargetTypes.User, user.Id);
        await db.SaveChangesAsync();
        await transaction.CommitAsync();
        return TypedResults.NoContent();
    }

    /// <summary>A new invitation link for a user who has not set a password yet; the old link stops working.</summary>
    private static async Task<Results<Created<SetupLinkDto>, ProblemHttpResult>> InviteAgainAsync(
        long id, UserManager<AppUser> users, AppDbContext db, SetupLinks links, AuditLog audit)
    {
        if (await FindAsync(users, id) is not { } user)
        {
            return NotFound();
        }

        if (user.PasswordHash is not null)
        {
            return ApiProblems.Of(ProblemTypes.Conflict, "This user accepted their invitation already. Send a password reset instead.");
        }

        var link = await links.IssueAsync(user, SetupLinkPurposes.Invitation);
        audit.Add(AuditActions.UserInvite, AuditTargetTypes.User, user.Id, new { email = user.Email });
        await db.SaveChangesAsync();
        return TypedResults.Created((string?)null, link);
    }

    /// <summary>Reads the merge patch, naming every field that is not valid or not allowed.</summary>
    private static async Task<(UserPatchRequest Patch, Dictionary<string, string[]> Errors)> ReadPatchAsync(HttpRequest request)
    {
        var errors = new Dictionary<string, string[]>();
        JsonObject? body;
        try
        {
            body = await JsonNode.ParseAsync(request.Body, cancellationToken: request.HttpContext.RequestAborted) as JsonObject;
        }
        catch (JsonException)
        {
            body = null;
        }

        if (body is null)
        {
            errors["body"] = ["Send a JSON merge patch object."];
            return (new UserPatchRequest(null, null, null), errors);
        }

        string? displayName = null;
        List<string>? roles = null;
        bool? disabled = null;
        foreach (var (name, value) in body)
        {
            switch (name)
            {
                case "displayName":
                    displayName = value is JsonValue text && text.TryGetValue<string>(out var s) ? s : null;
                    AddIfInvalid(errors, name, DisplayNameError(displayName));
                    displayName = displayName?.Trim();
                    break;
                case "roles":
                    roles = value is JsonArray array && array.All(r => r is JsonValue v && v.TryGetValue<string>(out _))
                        ? [.. array.Select(r => r!.GetValue<string>())]
                        : null;
                    AddIfInvalid(errors, name, RolesError(roles));
                    break;
                case "disabled":
                    disabled = value is JsonValue flag && flag.TryGetValue<bool>(out var b) ? b : null;
                    AddIfInvalid(errors, name, disabled is null ? "disabled is true or false." : null);
                    break;
                default:
                    errors[name] = ["Only displayName, roles and disabled can be changed."];
                    break;
            }
        }

        return (new UserPatchRequest(displayName, roles, disabled), errors);
    }

    private static Task<AppUser?> FindAsync(UserManager<AppUser> users, long id) =>
        users.Users.SingleOrDefaultAsync(u => u.Id == id);

    private static bool IsActiveAdmin(IEnumerable<string> roles, bool disabled) => !disabled && roles.Contains(Roles.Admin);

    /// <summary>
    /// Whether no other enabled Admin exists. Takes a lock held to the end of the transaction, so
    /// call it inside one.
    /// </summary>
    private static async Task<bool> IsLastActiveAdminAsync(AppDbContext db, long userId)
    {
        await db.Database.ExecuteSqlAsync($"SELECT pg_advisory_xact_lock({LastAdminLock})");
        var adminRoleId = await db.Roles.Where(r => r.Name == Roles.Admin).Select(r => r.Id).SingleAsync();
        return !await db.Users.AnyAsync(u => u.Id != userId
            && u.DisabledAt == null
            && db.UserRoles.Any(ur => ur.UserId == u.Id && ur.RoleId == adminRoleId));
    }

    private static string? DisplayNameError(string? name) => name?.Trim() switch
    {
        null or "" => "Enter a name.",
        { Length: > MaxDisplayName } => $"A name is at most {MaxDisplayName} characters.",
        _ => null,
    };

    private static string? RolesError(IReadOnlyCollection<string>? roles) => roles switch
    {
        null or { Count: 0 } => "Give at least one role. " + RolesMessage,
        _ when roles.FirstOrDefault(r => !Roles.All.Contains(r)) is { } unknown => $"'{unknown}' is not a role. {RolesMessage}",
        _ => null,
    };

    private static void AddIfInvalid(Dictionary<string, string[]> errors, string field, string? error)
    {
        if (error is not null)
        {
            errors[field] = [error];
        }
    }

    private static ProblemHttpResult NotFound() => ApiProblems.Of(ProblemTypes.NotFound, "There is no user with this id.");

    private static ProblemHttpResult EmailTaken() => ApiProblems.Of(ProblemTypes.Conflict, "A user with this email exists already.");

    private static ProblemHttpResult LastAdmin(string verb) =>
        ApiProblems.Of(ProblemTypes.Conflict, $"You can not {verb} the last Admin. Make another user an Admin first.");

    // Identity failures other than the ones answered above are bugs, so they end as a 500.
    private static void Succeeded(IdentityResult result)
    {
        if (!result.Succeeded)
        {
            throw new InvalidOperationException(string.Join(" ", result.Errors.Select(e => $"{e.Code}: {e.Description}")));
        }
    }

    private static string EscapeLike(string value) =>
        value.Replace(@"\", @"\\", StringComparison.Ordinal)
            .Replace("%", @"\%", StringComparison.Ordinal)
            .Replace("_", @"\_", StringComparison.Ordinal);
}
