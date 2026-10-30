using System.Security.Cryptography;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Runova.Website.Api.Problems;
using Runova.Website.Core.Problems;
using Runova.Website.Core.Signing;
using Runova.Website.Data;

namespace Runova.Website.Api.ApiClients;

/// <summary>
/// Authenticates a request signed per the contract's "Signed requests" section. Every check that
/// fails gives the same answer, so a caller learns nothing about which one it was; the reason is
/// only logged.
/// </summary>
internal sealed class SignatureAuthenticationHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> options,
    ILoggerFactory logger,
    UrlEncoder encoder,
    AppDbContext db,
    SigningKeys keys,
    TimeProvider clock)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    public const string SchemeName = "RunovaSignature";
    public const string RefusalDetail = "The request could not be authenticated.";

    private static readonly TimeSpan _lastUsedResolution = TimeSpan.FromMinutes(1);

    /// <summary>Answers 401 <c>unauthorized</c> with the one detail every refusal shares.</summary>
    public static ValueTask WriteRefusalAsync(HttpContext http) =>
        ApiProblems.WriteAsync(http, ProblemTypes.Unauthorized, RefusalDetail);

    protected override async Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        var headers = Request.Headers;
        if (!headers.ContainsKey(RequestSignature.KeyIdHeader))
        {
            return AuthenticateResult.NoResult();
        }

        var keyId = Single(RequestSignature.KeyIdHeader);
        var timestamp = Single(RequestSignature.TimestampHeader);
        var nonce = Single(RequestSignature.NonceHeader);
        var contentSha256 = Single(RequestSignature.ContentSha256Header);
        var signature = Single(RequestSignature.SignatureHeader);
        if (!RequestSignature.IsKeyId(keyId)
            || RequestSignature.ParseTimestamp(timestamp) is not { } seconds
            || !RequestSignature.IsNonce(nonce)
            || !RequestSignature.IsContentSha256(contentSha256)
            || string.IsNullOrEmpty(signature))
        {
            return Refuse("a signing header is missing or malformed");
        }

        var now = clock.GetUtcNow();
        if (Math.Abs(now.ToUnixTimeSeconds() - seconds) > RequestSignature.ClockSkew.TotalSeconds)
        {
            return Refuse("the timestamp is outside the clock skew");
        }

        if (await BodySha256Async() != contentSha256)
        {
            return Refuse("the body does not match its SHA-256");
        }

        var client = await db.ApiClients.AsNoTracking().SingleOrDefaultAsync(c => c.Keys.Any(k => k.KeyId == keyId), Context.RequestAborted);
        var key = client?.Keys.Single(k => k.KeyId == keyId);
        if (client is null || key is null || client.RevokedAt is not null || client.ExpiresAt <= now || key.ExpiresAt <= now)
        {
            return Refuse("the key is unknown, or its client is revoked or expired, or the key's overlap ended");
        }

        var (path, query) = Target();
        var canonical = RequestSignature.CanonicalString(Request.Method, path, query, timestamp!, nonce!, contentSha256!);
        if (keys.Unseal(key.SealedSigningKey) is not { } signingKey || !RequestSignature.Matches(signingKey, canonical, signature))
        {
            return Refuse("the signature does not match");
        }

        if (!IpAllowlist.Allows(client.IpAllowlist, Context.Connection.RemoteIpAddress))
        {
            return Refuse("the caller's address is not in the allowlist");
        }

        // Last, so only a request that passed every other check uses its nonce up.
        if (!await RememberNonceAsync(keyId!, nonce!, now))
        {
            return Refuse("the nonce was seen before");
        }

        var stale = now - _lastUsedResolution;
        await db.ApiClients
            .Where(c => c.Id == client.Id && (c.LastUsedAt == null || c.LastUsedAt <= stale))
            .ExecuteUpdateAsync(set => set.SetProperty(c => c.LastUsedAt, now), Context.RequestAborted);

        return AuthenticateResult.Success(new AuthenticationTicket(ApiClientPrincipal.Create(client, SchemeName), SchemeName));
    }

    protected override async Task HandleChallengeAsync(AuthenticationProperties properties) => await WriteRefusalAsync(Context);

    private string? Single(string header) => Request.Headers[header] is { Count: 1 } values ? values[0] : null;

    private static AuthenticateResult Refuse(string reason) => AuthenticateResult.Fail($"Signed request refused: {reason}.");

    /// <summary>The SHA-256 of the body, which stays readable for the endpoint.</summary>
    private async Task<string> BodySha256Async()
    {
        Request.EnableBuffering();
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[16 * 1024];
        int read;
        while ((read = await Request.Body.ReadAsync(buffer, Context.RequestAborted)) > 0)
        {
            hash.AppendData(buffer, 0, read);
        }

        Request.Body.Position = 0;
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    /// <summary>
    /// The path and query as the client sent them, from the raw request target. Should the server
    /// not have one, the path is escaped again from the parsed request.
    /// </summary>
    private (string Path, string? Query) Target()
    {
        var raw = Context.Features.Get<IHttpRequestFeature>()?.RawTarget;
        if (raw is ['/', ..])
        {
            var mark = raw.IndexOf('?', StringComparison.Ordinal);
            return mark < 0 ? (raw, null) : (raw[..mark], raw[(mark + 1)..]);
        }

        return ((Request.PathBase + Request.Path).ToUriComponent(), Request.QueryString.Value);
    }

    /// <summary>Stores the nonce; false when this key sent it before.</summary>
    private async Task<bool> RememberNonceAsync(string keyId, string nonce, DateTimeOffset now) =>
        await db.Database.ExecuteSqlAsync(
            $"""
            INSERT INTO "SignatureNonces" ("KeyId", "Nonce", "SeenAt") VALUES ({keyId}, {nonce}, {now})
            ON CONFLICT ("KeyId", "Nonce") DO NOTHING
            """,
            Context.RequestAborted) == 1;
}

internal static class SignatureAuthentication
{
    /// <summary>
    /// Answers 401 to a request that came with a key id but was not authenticated by it. Without
    /// this, a bad signature on an anonymous endpoint would simply be read as no credentials.
    /// Runs right after authentication.
    /// </summary>
    public static IApplicationBuilder UseSignatureRefusals(this IApplicationBuilder app) => app.Use(async (http, next) =>
    {
        if (IsSigned(http) && !ApiClientPrincipal.IsApiClient(http.User))
        {
            await SignatureAuthenticationHandler.WriteRefusalAsync(http);
            return;
        }

        await next(http);
    });

    /// <summary>Whether a request asks to be authenticated by signature rather than by the session cookie.</summary>
    public static bool IsSigned(HttpContext http) => http.Request.Headers.ContainsKey(RequestSignature.KeyIdHeader);
}
