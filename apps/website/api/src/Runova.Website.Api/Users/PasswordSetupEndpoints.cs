using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Identity;
using Runova.Website.Api.Audit;
using Runova.Website.Api.Identity;
using Runova.Website.Api.Problems;
using Runova.Website.Core.Audit;
using Runova.Website.Core.Problems;
using Runova.Website.Data;
using Runova.Website.Data.Identity;

namespace Runova.Website.Api.Users;

public sealed record PasswordSetupRequest(string? Token, string? Password);

/// <summary>Where the token from an invitation or password reset link is redeemed for a password.</summary>
internal static class PasswordSetupEndpoints
{
    public static RouteGroupBuilder MapPasswordSetups(this RouteGroupBuilder api)
    {
        api.MapPost("/password-setups", SetPasswordAsync).AllowAnonymous().WithMetadata(RequiresAntiforgery.Instance);
        return api;
    }

    /// <summary>
    /// Sets the password, confirms the email and lifts any lockout. The link is used up only when
    /// the password is accepted, so a too-short one can be retried with the same link.
    /// </summary>
    private static async Task<Results<NoContent, ValidationProblem, ProblemHttpResult>> SetPasswordAsync(
        PasswordSetupRequest request, UserManager<AppUser> users, AppDbContext db, SetupLinks links, AuditLog audit)
    {
        if (string.IsNullOrEmpty(request.Password))
        {
            return ApiProblems.Invalid("password", "Enter a password.");
        }

        await using var transaction = await db.Database.BeginTransactionAsync();
        var link = string.IsNullOrEmpty(request.Token) ? null : await links.FindAsync(request.Token);
        var user = link is null ? null : await users.FindByIdAsync(link.UserId.ToString(System.Globalization.CultureInfo.InvariantCulture));
        if (link is null || user is null)
        {
            return UnknownLink();
        }

        var problems = new List<string>();
        foreach (var validator in users.PasswordValidators)
        {
            var result = await validator.ValidateAsync(users, user, request.Password);
            problems.AddRange(result.Errors.Select(e => e.Description));
        }

        if (problems.Count > 0)
        {
            return ApiProblems.Invalid("password", string.Join(" ", problems));
        }

        if (!await links.UseAsync(link))
        {
            return UnknownLink();
        }

        if (await users.HasPasswordAsync(user))
        {
            Succeeded(await users.RemovePasswordAsync(user));
        }

        user.EmailConfirmed = true;
        user.AccessFailedCount = 0;
        user.LockoutEnd = null;
        Succeeded(await users.AddPasswordAsync(user, request.Password));
        audit.Add(AuditActions.UserUpdate, AuditTargetTypes.User, user.Id, new { passwordChanged = true, emailConfirmed = true }, actorId: user.Id);
        await db.SaveChangesAsync();
        await transaction.CommitAsync();
        return TypedResults.NoContent();
    }

    private static ProblemHttpResult UnknownLink() =>
        ApiProblems.Of(ProblemTypes.NotFound, "This link is not valid. It may have been used or expired; ask an Admin for a new one.");

    private static void Succeeded(IdentityResult result)
    {
        if (!result.Succeeded)
        {
            throw new InvalidOperationException(string.Join(" ", result.Errors.Select(e => $"{e.Code}: {e.Description}")));
        }
    }
}
