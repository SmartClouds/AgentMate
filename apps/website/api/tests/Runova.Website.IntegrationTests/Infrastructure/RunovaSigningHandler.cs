using System.Globalization;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;

namespace Runova.Website.IntegrationTests.Infrastructure;

/// <summary>
/// The C# reference client for signed requests (scheme v1 in docs/website/api-contract.md). It
/// uses nothing from the API's own code, so the tests check the contract and not the server's
/// reading of it, and another system can copy it as it is:
/// <code>
/// var http = new HttpClient(new RunovaSigningHandler(keyId, secret) { InnerHandler = new HttpClientHandler() });
/// </code>
/// </summary>
internal sealed class RunovaSigningHandler(string keyId, string secret) : DelegatingHandler
{
    /// <summary>Unix seconds to sign with; the current time when null. Tests fix it.</summary>
    public Func<long>? Clock { get; init; }

    /// <summary>The nonce for the next request; 16 random bytes when null. Tests fix it.</summary>
    public Func<string>? Nonces { get; init; }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        // The body is read once and sent as exactly the bytes that were hashed.
        var body = request.Content is null ? [] : await request.Content.ReadAsByteArrayAsync(cancellationToken);
        if (request.Content is not null)
        {
            var content = new ByteArrayContent(body);
            foreach (var header in request.Content.Headers)
            {
                content.Headers.TryAddWithoutValidation(header.Key, header.Value);
            }

            request.Content = content;
        }

        var timestamp = (Clock?.Invoke() ?? DateTimeOffset.UtcNow.ToUnixTimeSeconds()).ToString(CultureInfo.InvariantCulture);
        var nonce = Nonces?.Invoke() ?? Base64Url(RandomNumberGenerator.GetBytes(16));
        foreach (var (name, value) in Sign(keyId, secret, request.Method.Method, request.RequestUri!, body, timestamp, nonce))
        {
            request.Headers.Remove(name);
            request.Headers.TryAddWithoutValidation(name, value);
        }

        return await base.SendAsync(request, cancellationToken);
    }

    /// <summary>The five signing headers for one request to an absolute URI.</summary>
    public static IReadOnlyList<(string Name, string Value)> Sign(
        string keyId, string secret, string method, Uri uri, byte[] body, string timestamp, string nonce)
    {
        var contentSha256 = Convert.ToHexStringLower(SHA256.HashData(body));
        var canonical = string.Join(
            '\n', "RUNOVA-HMAC-SHA256", method.ToUpperInvariant(), uri.AbsolutePath, CanonicalQuery(uri.Query), timestamp, nonce, contentSha256);
        var signingKey = SHA256.HashData(Encoding.UTF8.GetBytes(secret));
        var signature = Convert.ToHexStringLower(HMACSHA256.HashData(signingKey, Encoding.UTF8.GetBytes(canonical)));
        return
        [
            ("X-Runova-Key-Id", keyId),
            ("X-Runova-Timestamp", timestamp),
            ("X-Runova-Nonce", nonce),
            ("X-Runova-Content-SHA256", contentSha256),
            ("X-Runova-Signature", "v1=" + signature),
        ];
    }

    public static string CanonicalQuery(string query)
    {
        query = query.StartsWith('?') ? query[1..] : query;
        if (query.Length == 0)
        {
            return "";
        }

        return string.Join('&', query.Split('&')
            .Select(part => part.Split('=', 2))
            .Select(pair => (Name: Encode(Decode(pair[0])), Value: Encode(Decode(pair.Length > 1 ? pair[1] : ""))))
            .OrderBy(p => p.Name, StringComparer.Ordinal)
            .ThenBy(p => p.Value, StringComparer.Ordinal)
            .Select(p => p.Name + "=" + p.Value));
    }

    public static string Base64Url(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static string Decode(string value) => Uri.UnescapeDataString(value.Replace('+', ' '));

    private static string Encode(string value) =>
        string.Concat(Encoding.UTF8.GetBytes(value).Select(b =>
            (char)b is (>= 'A' and <= 'Z') or (>= 'a' and <= 'z') or (>= '0' and <= '9') or '-' or '.' or '_' or '~'
                ? ((char)b).ToString()
                : "%" + b.ToString("X2", CultureInfo.InvariantCulture)));
}

/// <summary>A JSON body, as an <see cref="HttpContent"/> for a signed request.</summary>
internal static class SignedContent
{
    public static ByteArrayContent Json(string json)
    {
        var content = new ByteArrayContent(Encoding.UTF8.GetBytes(json));
        content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        return content;
    }
}
