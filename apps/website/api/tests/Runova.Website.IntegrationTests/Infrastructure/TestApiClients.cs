using System.Net.Http.Headers;
using System.Text;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Runova.Website.Api.ApiClients;
using Runova.Website.Core.ApiClients;
using Runova.Website.Core.Signing;
using Runova.Website.Data;

namespace Runova.Website.IntegrationTests.Infrastructure;

/// <summary>API clients written straight to the database, and HTTP clients that sign as them.</summary>
internal static class TestApiClients
{
    /// <summary>The contract's test vector time, 2026-10-30T12:00:00Z, which signing tests fix the clock at.</summary>
    public static readonly DateTimeOffset Now = DateTimeOffset.FromUnixTimeSeconds(1793361600);

    public const string VectorKeyId = "rk_00000000000000a1";
    public const string VectorSecret = "rnv_sk_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

    /// <summary>The request header the test host reads the caller's address from.</summary>
    public const string RemoteIpHeader = "X-Test-Remote-Ip";

    /// <summary>A client with one key, sealed as the API seals it. A new key id and secret unless given.</summary>
    public static async Task<(string KeyId, string Secret)> AddAsync(
        IServiceProvider services,
        string? keyId = null,
        string? secret = null,
        string[]? scopes = null,
        string[]? ipAllowlist = null,
        DateTimeOffset? expiresAt = null,
        DateTimeOffset? revokedAt = null,
        string? name = null)
    {
        keyId ??= RequestSignature.NewKeyId();
        secret ??= RequestSignature.NewSecret();
        using var scope = services.CreateScope();
        var keys = scope.ServiceProvider.GetRequiredService<SigningKeys>();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        db.ApiClients.Add(new Core.ApiClients.ApiClient
        {
            Name = name ?? "Test client " + keyId,
            Scopes = [.. scopes ?? [ApiScopes.NewsWrite]],
            IpAllowlist = [.. ipAllowlist ?? []],
            Keys = [new ApiClientKey { KeyId = keyId, SealedSigningKey = keys.Seal(RequestSignature.SigningKey(secret)), CreatedAt = Now }],
            ExpiresAt = expiresAt,
            RevokedAt = revokedAt,
            CreatedAt = Now,
        });
        await db.SaveChangesAsync(TestContext.Current.CancellationToken);
        return (keyId, secret);
    }

    /// <summary>An HTTP client that signs every request through the C# reference client.</summary>
    public static HttpClient Http(WebsiteApiFactory factory, string keyId, string secret, Func<long>? clock = null) =>
        factory.CreateDefaultClient(
            new Uri("https://localhost"),
            new RunovaSigningHandler(keyId, secret) { Clock = clock ?? (() => Now.ToUnixTimeSeconds()) });

    /// <summary>
    /// A request signed by hand, so a test can change any part of it after signing.
    /// <paramref name="change"/> gets the headers and may replace or remove them.
    /// </summary>
    public static HttpRequestMessage Signed(
        string keyId,
        string secret,
        HttpMethod method,
        string pathAndQuery,
        string? body = null,
        long? timestamp = null,
        string? nonce = null,
        Action<Dictionary<string, string>>? change = null,
        string? sentBody = null)
    {
        var uri = new Uri(new Uri("https://localhost"), pathAndQuery);
        var bytes = body is null ? [] : Encoding.UTF8.GetBytes(body);
        var headers = RunovaSigningHandler.Sign(
                keyId,
                secret,
                method.Method,
                uri,
                bytes,
                (timestamp ?? Now.ToUnixTimeSeconds()).ToString(System.Globalization.CultureInfo.InvariantCulture),
                nonce ?? RunovaSigningHandler.Base64Url(System.Security.Cryptography.RandomNumberGenerator.GetBytes(16)))
            .ToDictionary(h => h.Name, h => h.Value);
        change?.Invoke(headers);

        var request = new HttpRequestMessage(method, uri);
        if ((sentBody ?? body) is { } content)
        {
            request.Content = new StringContent(content, Encoding.UTF8, new MediaTypeHeaderValue("application/json"));
            request.Content.Headers.ContentType!.CharSet = null;
        }

        foreach (var (name, value) in headers)
        {
            request.Headers.TryAddWithoutValidation(name, value);
        }

        return request;
    }

    public static HttpClient Raw(WebsiteApiFactory factory) =>
        factory.CreateClient(new WebApplicationFactoryClientOptions { BaseAddress = new Uri("https://localhost"), AllowAutoRedirect = false });
}
