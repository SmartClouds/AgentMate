using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Npgsql;
using Runova.Website.Api.Audit;
using Runova.Website.Api.Http;
using Runova.Website.Api.Identity;
using Runova.Website.Api.Paging;
using Runova.Website.Api.Problems;
using Runova.Website.Core.ApiClients;
using Runova.Website.Core.Audit;
using Runova.Website.Core.Json;
using Runova.Website.Core.Paging;
using Runova.Website.Core.Problems;
using Runova.Website.Core.Signing;
using Runova.Website.Data;
using JsonOptions = Microsoft.AspNetCore.Http.Json.JsonOptions;

namespace Runova.Website.Api.ApiClients;

/// <summary>The fields an API client is created with, and that a merge patch may change.</summary>
public sealed record ApiClientWriteRequest(string? Name, IReadOnlyList<string>? Scopes, IReadOnlyList<string>? IpAllowlist, DateTimeOffset? ExpiresAt);

public sealed record ApiClientRotateRequest(int? OverlapMinutes);

/// <summary>
/// API clients, for Admins only. A secret is shown once, in the answer that made it, and the API
/// keeps only its sealed hash. Every change writes an audit entry with it.
/// </summary>
internal static class ApiClientEndpoints
{
    private const int MaxName = 100;
    private const int DefaultOverlapMinutes = 1440;
    private const int MaxOverlapMinutes = 10080;

    public static RouteGroupBuilder MapApiClients(this RouteGroupBuilder api)
    {
        var clients = api.MapGroup("/api-clients").RequireAuthorization(Policies.Admin);
        clients.MapGet("", ListAsync);
        clients.MapPost("", CreateAsync).Accepts<ApiClientWriteRequest>("application/json");
        clients.MapGet("/{id:long}", GetAsync).Produces(StatusCodes.Status304NotModified);
        clients.MapPatch("/{id:long}", PatchAsync).Accepts<ApiClientWriteRequest>("application/merge-patch+json", "application/json");
        clients.MapDelete("/{id:long}", RevokeAsync);
        clients.MapPost("/{id:long}/secrets", RotateAsync).Accepts<ApiClientRotateRequest>("application/json");
        return api;
    }

    private static async Task<Results<Ok<Page<ApiClientDto>>, ValidationProblem>> ListAsync(
        int? page, int? pageSize, bool? revoked, AppDbContext db, HttpContext http)
    {
        var request = PageRequest.Parse(page, pageSize, out var errors);
        if (errors.Count > 0)
        {
            return ApiProblems.Invalid(errors);
        }

        IQueryable<ApiClient> query = db.ApiClients.AsNoTracking();
        if (revoked is { } wanted)
        {
            query = wanted ? query.Where(c => c.RevokedAt != null) : query.Where(c => c.RevokedAt == null);
        }

        var total = await query.CountAsync();
        var clients = await query.OrderBy(c => c.Id).Skip(request.Skip).Take(request.Size).ToListAsync();

        var result = Page.Of([.. clients.Select(ApiClientMapper.ToDto)], request, total);
        PageLinks.Set(http, result);
        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Ok(result);
    }

    private static async Task<Results<Created<ApiClientCreatedDto>, ValidationProblem, ProblemHttpResult>> CreateAsync(
        HttpContext http, AppDbContext db, AuditLog audit, SigningKeys keys, TimeProvider time, IOptions<JsonOptions> json)
    {
        var now = time.GetUtcNow();
        var errors = new Dictionary<string, string[]>();
        var request = await ReadAsync(http, json.Value.SerializerOptions, current: null, now, errors);
        if (request is null)
        {
            return ApiProblems.Invalid(errors);
        }

        if (await db.ApiClients.AnyAsync(c => c.Name == request.Name))
        {
            return NameTaken();
        }

        var keyId = RequestSignature.NewKeyId();
        var secret = RequestSignature.NewSecret();
        var client = new ApiClient
        {
            Keys = [new ApiClientKey { KeyId = keyId, SealedSigningKey = keys.Seal(RequestSignature.SigningKey(secret)), CreatedAt = now }],
            CreatedAt = now,
        };
        Apply(request, client);

        await using var transaction = await db.Database.BeginTransactionAsync();
        db.ApiClients.Add(client);
        if (!await TrySaveAsync(db))
        {
            return NameTaken();
        }

        audit.Add(AuditActions.ApiClientCreate, AuditTargetTypes.ApiClient, client.Id, new
        {
            name = client.Name,
            scopes = client.Scopes,
            ipAllowlist = client.IpAllowlist,
            expiresAt = client.ExpiresAt,
            keyId,
        });
        await db.SaveChangesAsync();
        await transaction.CommitAsync();

        SetHeaders(http.Response, client);
        return TypedResults.Created($"{ApiV1.Prefix}/api-clients/{client.Id}", new ApiClientCreatedDto(ApiClientMapper.ToDto(client), keyId, secret));
    }

    private static async Task<Results<Ok<ApiClientDto>, StatusCodeHttpResult, ProblemHttpResult>> GetAsync(long id, AppDbContext db, HttpContext http)
    {
        if (await db.ApiClients.AsNoTracking().SingleOrDefaultAsync(c => c.Id == id) is not { } client)
        {
            return NotFound();
        }

        if (HttpCaching.IsNotModified(http, Versions.ETag(client.Version), HttpCaching.Private))
        {
            return TypedResults.StatusCode(StatusCodes.Status304NotModified);
        }

        return TypedResults.Ok(ApiClientMapper.ToDto(client));
    }

    /// <summary>A JSON merge patch, validated as the whole client it makes.</summary>
    private static async Task<Results<Ok<ApiClientDto>, ValidationProblem, ProblemHttpResult>> PatchAsync(
        long id, HttpContext http, AppDbContext db, AuditLog audit, TimeProvider time, IOptions<JsonOptions> json)
    {
        if (await db.ApiClients.SingleOrDefaultAsync(c => c.Id == id) is not { } client)
        {
            return NotFound();
        }

        if (Versions.CheckIfMatch(http.Request, client.Version) is { } precondition)
        {
            return precondition;
        }

        var options = json.Value.SerializerOptions;
        var before = JsonSerializer.SerializeToNode(ToWriteRequest(client), options)!.AsObject();
        var errors = new Dictionary<string, string[]>();
        var request = await ReadAsync(http, options, before, time.GetUtcNow(), errors);
        if (request is null)
        {
            return ApiProblems.Invalid(errors);
        }

        if (request.Name != client.Name && await db.ApiClients.AnyAsync(c => c.Name == request.Name && c.Id != id))
        {
            return NameTaken();
        }

        Apply(request, client);
        var after = JsonSerializer.SerializeToNode(ToWriteRequest(client), options)!.AsObject();
        var changed = after.Where(p => !JsonNode.DeepEquals(p.Value, before[p.Key])).Select(p => p.Key).ToList();

        // A patch that changes nothing saves nothing, so the version and the audit log stay as they are.
        if (changed.Count > 0)
        {
            audit.Add(AuditActions.ApiClientUpdate, AuditTargetTypes.ApiClient, client.Id, new { fields = changed });
            try
            {
                if (!await TrySaveAsync(db))
                {
                    return NameTaken();
                }
            }
            catch (DbUpdateConcurrencyException)
            {
                return await ChangedMeanwhileAsync(db, id);
            }
        }

        SetHeaders(http.Response, client);
        return TypedResults.Ok(ApiClientMapper.ToDto(client));
    }

    /// <summary>Revokes the client at once. It stays, so the audit trail can still name it.</summary>
    private static async Task<Results<NoContent, ProblemHttpResult>> RevokeAsync(
        long id, HttpRequest request, AppDbContext db, AuditLog audit, TimeProvider time)
    {
        if (await db.ApiClients.SingleOrDefaultAsync(c => c.Id == id) is not { } client)
        {
            return NotFound();
        }

        if (Versions.CheckIfMatch(request, client.Version) is { } precondition)
        {
            return precondition;
        }

        if (client.RevokedAt is not null)
        {
            return TypedResults.NoContent();
        }

        client.RevokedAt = time.GetUtcNow();
        audit.Add(AuditActions.ApiClientRevoke, AuditTargetTypes.ApiClient, client.Id, new { name = client.Name });
        try
        {
            await db.SaveChangesAsync();
        }
        catch (DbUpdateConcurrencyException)
        {
            return await ChangedMeanwhileAsync(db, id);
        }

        return TypedResults.NoContent();
    }

    /// <summary>
    /// A new key and secret. The current key keeps working for the overlap, so the other system
    /// can switch without a gap; keys whose overlap already ended are dropped.
    /// </summary>
    private static async Task<Results<Created<ApiClientSecretDto>, ValidationProblem, ProblemHttpResult>> RotateAsync(
        long id, HttpContext http, AppDbContext db, AuditLog audit, SigningKeys keys, TimeProvider time, IOptions<JsonOptions> json)
    {
        var errors = new Dictionary<string, string[]>();
        var overlapMinutes = DefaultOverlapMinutes;
        if (http.Request.ContentLength is not 0)
        {
            if (await RequestBodies.ReadObjectAsync(http.Request, errors) is not { } body
                || RequestBodies.Deserialize<ApiClientRotateRequest>(body, json.Value.SerializerOptions, errors) is not { } request)
            {
                return ApiProblems.Invalid(errors);
            }

            overlapMinutes = request.OverlapMinutes ?? DefaultOverlapMinutes;
            if (overlapMinutes is < 0 or > MaxOverlapMinutes)
            {
                return ApiProblems.Invalid("overlapMinutes", $"Give 0 to {MaxOverlapMinutes} minutes.");
            }
        }

        if (await db.ApiClients.SingleOrDefaultAsync(c => c.Id == id && c.RevokedAt == null) is not { } client)
        {
            return NotFound();
        }

        var now = time.GetUtcNow();
        var previousKeyExpiresAt = now.AddMinutes(overlapMinutes);
        foreach (var key in client.Keys.Where(k => k.ExpiresAt is null))
        {
            key.ExpiresAt = previousKeyExpiresAt;
        }

        client.Keys.RemoveAll(k => k.ExpiresAt <= now);
        var keyId = RequestSignature.NewKeyId();
        var secret = RequestSignature.NewSecret();
        client.Keys.Add(new ApiClientKey { KeyId = keyId, SealedSigningKey = keys.Seal(RequestSignature.SigningKey(secret)), CreatedAt = now });

        audit.Add(AuditActions.ApiClientRotate, AuditTargetTypes.ApiClient, client.Id, new { keyId, previousKeyExpiresAt });
        await db.SaveChangesAsync();

        http.Response.Headers.CacheControl = HttpCaching.Private;
        return TypedResults.Created($"{ApiV1.Prefix}/api-clients/{client.Id}", new ApiClientSecretDto(keyId, secret, previousKeyExpiresAt));
    }

    /// <summary>
    /// Reads the body, merged into <paramref name="current"/> when there is one, and validates the
    /// result. Null when anything is wrong, with the reasons in <paramref name="errors"/>.
    /// </summary>
    private static async Task<ApiClientWriteRequest?> ReadAsync(
        HttpContext http, JsonSerializerOptions json, JsonObject? current, DateTimeOffset now, Dictionary<string, string[]> errors)
    {
        if (await RequestBodies.ReadObjectAsync(http.Request, errors) is not { } body)
        {
            return null;
        }

        var node = current is null ? body : MergePatch.Apply(current, body)!;
        if (RequestBodies.Deserialize<ApiClientWriteRequest>(node, json, errors) is not { } request)
        {
            return null;
        }

        var name = request.Name?.Trim() ?? "";
        if (name.Length is 0 or > MaxName)
        {
            errors["name"] = [$"Give a name of 1 to {MaxName} characters."];
        }

        if (request.Scopes is not { Count: > 0 } scopes)
        {
            errors["scopes"] = [$"Give at least one scope: {string.Join(", ", ApiScopes.All)}."];
        }
        else
        {
            for (var i = 0; i < scopes.Count; i++)
            {
                if (!ApiScopes.All.Contains(scopes[i]))
                {
                    errors[$"scopes[{i}]"] = [$"Scopes are {string.Join(", ", ApiScopes.All)}."];
                }
            }
        }

        var allowlist = request.IpAllowlist ?? [];
        for (var i = 0; i < allowlist.Count; i++)
        {
            if (allowlist[i] is null || !IpAllowlist.IsValidEntry(allowlist[i]))
            {
                errors[$"ipAllowlist[{i}]"] = ["Give an IPv4 or IPv6 address or a CIDR range."];
            }
        }

        // A client that already expired may still be renamed; only a new expiry must lie ahead.
        var expiryChanged = current is null || !JsonNode.DeepEquals(node["expiresAt"], current["expiresAt"]);
        if (expiryChanged && request.ExpiresAt <= now)
        {
            errors["expiresAt"] = ["Give a time in the future, or null for no expiry."];
        }

        return errors.Count > 0
            ? null
            : request with { Name = name, Scopes = [.. request.Scopes!.Distinct()], IpAllowlist = [.. allowlist.Distinct()] };
    }

    private static void Apply(ApiClientWriteRequest request, ApiClient client)
    {
        client.Name = request.Name!;
        if (!client.Scopes.SequenceEqual(request.Scopes!))
        {
            client.Scopes = [.. request.Scopes!];
        }

        if (!client.IpAllowlist.SequenceEqual(request.IpAllowlist!))
        {
            client.IpAllowlist = [.. request.IpAllowlist!];
        }

        client.ExpiresAt = request.ExpiresAt;
    }

    private static ApiClientWriteRequest ToWriteRequest(ApiClient client) =>
        new(client.Name, [.. client.Scopes], [.. client.IpAllowlist], client.ExpiresAt);

    /// <summary>Saves, or answers false when the name was taken by a write that won the race.</summary>
    private static async Task<bool> TrySaveAsync(AppDbContext db)
    {
        try
        {
            await db.SaveChangesAsync();
            return true;
        }
        catch (DbUpdateException e) when (e.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
        {
            return false;
        }
    }

    private static async Task<ProblemHttpResult> ChangedMeanwhileAsync(AppDbContext db, long id)
    {
        var version = await db.ApiClients.AsNoTracking().Where(c => c.Id == id).Select(c => c.Version).SingleAsync();
        return Versions.Stale(version);
    }

    private static void SetHeaders(HttpResponse response, ApiClient client)
    {
        Versions.SetETag(response, client.Version);
        response.Headers.CacheControl = HttpCaching.Private;
    }

    private static ProblemHttpResult NotFound() => ApiProblems.Of(ProblemTypes.NotFound, "There is no API client with this id.");

    private static ProblemHttpResult NameTaken() => ApiProblems.Of(ProblemTypes.Conflict, "Another API client already has this name.");
}
