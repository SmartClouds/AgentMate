using System.Buffers.Text;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace Runova.Website.Core.Signing;

/// <summary>
/// The <c>v1</c> request signature of the contract's "Signed requests" section: the canonical
/// string, the signing key made from a secret, and the HMAC-SHA256 over the one with the other.
/// </summary>
public static class RequestSignature
{
    public const string Algorithm = "RUNOVA-HMAC-SHA256";
    public const string VersionPrefix = "v1=";

    public const string KeyIdHeader = "X-Runova-Key-Id";
    public const string TimestampHeader = "X-Runova-Timestamp";
    public const string NonceHeader = "X-Runova-Nonce";
    public const string ContentSha256Header = "X-Runova-Content-SHA256";
    public const string SignatureHeader = "X-Runova-Signature";

    public const string KeyIdPrefix = "rk_";
    public const string SecretPrefix = "rnv_sk_";

    /// <summary>How far a request's timestamp may be from the server clock, either way.</summary>
    public static readonly TimeSpan ClockSkew = TimeSpan.FromMinutes(5);

    /// <summary>How long a nonce is kept and refused again: twice the skew, so it covers both sides of it.</summary>
    public static readonly TimeSpan NonceLifetime = TimeSpan.FromMinutes(10);

    /// <summary>The HMAC key: the SHA-256 of the secret's UTF-8 bytes, prefix included.</summary>
    public static byte[] SigningKey(string secret) => SHA256.HashData(Encoding.UTF8.GetBytes(secret));

    /// <summary>The lowercase hex SHA-256 of the body, or of nothing when there is none.</summary>
    public static string ContentSha256(ReadOnlySpan<byte> body) => Convert.ToHexStringLower(SHA256.HashData(body));

    /// <summary>The seven lines that are signed, joined by LF with none at the end.</summary>
    public static string CanonicalString(
        string method, string path, string? rawQuery, string timestamp, string nonce, string contentSha256) =>
        string.Join('\n', Algorithm, method.ToUpperInvariant(), path, CanonicalQuery(rawQuery), timestamp, nonce, contentSha256);

    /// <summary>
    /// The query decoded (<c>+</c> read as a space), encoded again per RFC 3986 with upper-case
    /// hex, and sorted by name, then value, in ordinal order. A leading <c>?</c> is ignored.
    /// </summary>
    public static string CanonicalQuery(string? rawQuery)
    {
        var query = rawQuery is ['?', .. var rest] ? rest : rawQuery;
        if (string.IsNullOrEmpty(query))
        {
            return "";
        }

        var pairs = query.Split('&').Select(part =>
        {
            var equals = part.IndexOf('=', StringComparison.Ordinal);
            var name = equals < 0 ? part : part[..equals];
            var value = equals < 0 ? "" : part[(equals + 1)..];
            return (Name: Encode(Decode(name)), Value: Encode(Decode(value)));
        });
        return string.Join('&', pairs
            .OrderBy(p => p.Name, StringComparer.Ordinal)
            .ThenBy(p => p.Value, StringComparer.Ordinal)
            .Select(p => $"{p.Name}={p.Value}"));
    }

    /// <summary>The value of the signature header for a canonical string: <c>v1=</c> and lowercase hex.</summary>
    public static string Sign(ReadOnlySpan<byte> signingKey, string canonicalString) =>
        VersionPrefix + Convert.ToHexStringLower(HMACSHA256.HashData(signingKey, Encoding.UTF8.GetBytes(canonicalString)));

    /// <summary>Whether the header is the signature of the canonical string, compared in constant time.</summary>
    public static bool Matches(ReadOnlySpan<byte> signingKey, string canonicalString, string signatureHeader) =>
        CryptographicOperations.FixedTimeEquals(
            Encoding.ASCII.GetBytes(Sign(signingKey, canonicalString)),
            Encoding.UTF8.GetBytes(signatureHeader));

    public static bool IsKeyId(string? value) =>
        value is { Length: 19 } && value.StartsWith(KeyIdPrefix, StringComparison.Ordinal) && value[3..].All(IsLowerHex);

    public static bool IsNonce(string? value) =>
        value is { Length: >= 22 and <= 64 } && value.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_');

    public static bool IsContentSha256(string? value) => value is { Length: 64 } && value.All(IsLowerHex);

    /// <summary>Whole Unix seconds written as plain digits, or null.</summary>
    public static long? ParseTimestamp(string? value) =>
        value is { Length: > 0 and <= 19 } && value.All(char.IsAsciiDigit)
        && long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var seconds)
            ? seconds
            : null;

    /// <summary>A new key id: <c>rk_</c> and 16 lowercase hex characters.</summary>
    public static string NewKeyId() => KeyIdPrefix + Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(8));

    /// <summary>A new secret: <c>rnv_sk_</c> and 32 random bytes in base64url without padding.</summary>
    public static string NewSecret() => SecretPrefix + Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(32));

    private static bool IsLowerHex(char c) => char.IsAsciiDigit(c) || c is >= 'a' and <= 'f';

    private static string Decode(string value) => Uri.UnescapeDataString(value.Replace('+', ' '));

    private static string Encode(string value)
    {
        var builder = new StringBuilder(value.Length);
        foreach (var b in Encoding.UTF8.GetBytes(value))
        {
            if (char.IsAsciiLetterOrDigit((char)b) || b is (byte)'-' or (byte)'.' or (byte)'_' or (byte)'~')
            {
                builder.Append((char)b);
            }
            else
            {
                builder.Append('%').Append(b.ToString("X2", CultureInfo.InvariantCulture));
            }
        }

        return builder.ToString();
    }
}
