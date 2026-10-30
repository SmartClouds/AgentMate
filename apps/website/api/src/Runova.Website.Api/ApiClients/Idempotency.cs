using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Runova.Website.Api.Audit;
using Runova.Website.Api.Problems;
using Runova.Website.Core.Problems;
using Runova.Website.Data;
using Runova.Website.Data.ApiClients;

namespace Runova.Website.Api.ApiClients;

/// <summary>Marks a POST endpoint that honours <c>Idempotency-Key</c>.</summary>
internal sealed class Idempotent
{
    public static readonly Idempotent Instance = new();

    private Idempotent()
    {
    }
}

/// <summary>
/// <c>Idempotency-Key</c> on the endpoints marked <see cref="Idempotent"/>: the first answer under
/// a key is kept for 24 hours per caller, and the same key with the same body gets it again with
/// <c>Idempotent-Replayed: true</c> instead of running the endpoint a second time.
/// </summary>
internal static class Idempotency
{
    public const string KeyHeader = "Idempotency-Key";
    public const string ReplayedHeader = "Idempotent-Replayed";

    public static readonly TimeSpan Lifetime = TimeSpan.FromHours(24);

    /// <summary>Runs after authorization, so only a caller allowed to POST keeps an answer.</summary>
    public static IApplicationBuilder UseIdempotencyKeys(this IApplicationBuilder app) => app.Use(async (http, next) =>
    {
        if (!HttpMethods.IsPost(http.Request.Method)
            || http.GetEndpoint()?.Metadata.GetMetadata<Idempotent>() is null
            || !http.Request.Headers.TryGetValue(KeyHeader, out var values)
            || AuditLog.Actor(http.User) is not (var callerKind, { } callerId))
        {
            await next(http);
            return;
        }

        if (values is not [{ Length: >= 1 and <= 255 } key] || !key.All(c => c is >= '!' and <= '~'))
        {
            await ApiProblems.WriteAsync(
                http,
                ProblemTypes.ValidationFailed,
                "One or more fields are not valid.",
                new Dictionary<string, string[]> { [KeyHeader] = ["Send 1 to 255 visible ASCII characters."] });
            return;
        }

        var requestHash = await BodyHashAsync(http.Request);
        var now = http.RequestServices.GetRequiredService<TimeProvider>().GetUtcNow();

        // A context of its own, so the endpoint's changes and this record never share a save.
        await using var scope = http.RequestServices.GetRequiredService<IServiceScopeFactory>().CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var records = db.IdempotencyRecords.Where(r => r.CallerKind == callerKind && r.CallerId == callerId && r.Key == key);
        var expired = now - Lifetime;
        await records.Where(r => r.CreatedAt <= expired).ExecuteDeleteAsync(http.RequestAborted);

        var claimed = await db.Database.ExecuteSqlAsync(
            $"""
            INSERT INTO "IdempotencyRecords" ("CallerKind", "CallerId", "Key", "RequestHash", "StatusCode", "CreatedAt")
            VALUES ({callerKind}, {callerId}, {key}, {requestHash}, 0, {now})
            ON CONFLICT ("CallerKind", "CallerId", "Key") DO NOTHING
            """,
            http.RequestAborted) == 1;
        if (!claimed)
        {
            await AnswerFromRecordAsync(http, await records.AsNoTracking().SingleOrDefaultAsync(http.RequestAborted), requestHash);
            return;
        }

        var response = http.Response;
        var original = response.Body;
        using var buffer = new MemoryStream();
        response.Body = buffer;
        try
        {
            await next(http);
        }
        catch
        {
            await records.ExecuteDeleteAsync(CancellationToken.None);
            throw;
        }
        finally
        {
            response.Body = original;
        }

        // A server error is not an answer worth keeping: the client should be able to retry.
        if (response.StatusCode >= StatusCodes.Status500InternalServerError)
        {
            await records.ExecuteDeleteAsync(CancellationToken.None);
        }
        else
        {
            var body = Encoding.UTF8.GetString(buffer.GetBuffer(), 0, (int)buffer.Length);
            string? contentType = response.ContentType, location = Header(response, "Location"), etag = Header(response, "ETag");
            await records.ExecuteUpdateAsync(
                set => set
                    .SetProperty(r => r.StatusCode, response.StatusCode)
                    .SetProperty(r => r.ContentType, contentType)
                    .SetProperty(r => r.Location, location)
                    .SetProperty(r => r.ETag, etag)
                    .SetProperty(r => r.Body, body),
                CancellationToken.None);
        }

        buffer.Position = 0;
        await buffer.CopyToAsync(original, http.RequestAborted);
    });

    private static async Task AnswerFromRecordAsync(HttpContext http, IdempotencyRecord? record, byte[] requestHash)
    {
        if (record is not null && !CryptographicOperations.FixedTimeEquals(record.RequestHash, requestHash))
        {
            await ApiProblems.WriteAsync(
                http, ProblemTypes.IdempotencyKeyReused, "This Idempotency-Key was used with another body. Use a new key for a new request.");
            return;
        }

        if (record is not { StatusCode: > 0 })
        {
            await ApiProblems.WriteAsync(
                http, ProblemTypes.Conflict, "The first request with this Idempotency-Key has not finished yet. Retry in a moment.");
            return;
        }

        var response = http.Response;
        response.StatusCode = record.StatusCode;
        response.ContentType = record.ContentType;
        SetIfPresent(response, "Location", record.Location);
        SetIfPresent(response, "ETag", record.ETag);
        response.Headers[ReplayedHeader] = "true";
        if (!string.IsNullOrEmpty(record.Body))
        {
            await response.WriteAsync(record.Body, http.RequestAborted);
        }
    }

    private static async Task<byte[]> BodyHashAsync(HttpRequest request)
    {
        request.EnableBuffering();
        var hash = await SHA256.HashDataAsync(request.Body, request.HttpContext.RequestAborted);
        request.Body.Position = 0;
        return hash;
    }

    private static string? Header(HttpResponse response, string name) =>
        response.Headers.TryGetValue(name, out var value) ? value.ToString() : null;

    private static void SetIfPresent(HttpResponse response, string name, string? value)
    {
        if (value is not null)
        {
            response.Headers[name] = value;
        }
    }
}
