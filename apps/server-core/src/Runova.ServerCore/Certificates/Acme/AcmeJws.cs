using System.Buffers.Text;
using System.Text;
using System.Text.Json;

namespace Runova.ServerCore.Certificates.Acme;

/// <summary>
/// The request bodies of ACME: flattened JWS JSON (RFC 7515 section 7.2.2) with the protected
/// header RFC 8555 section 6.2 asks for. A new account (and the inner JWS of a key change) names
/// its key with "jwk"; every other request names the account URL with "kid".
/// </summary>
internal static class AcmeJws
{
    /// <summary>The exact Content-Type of a signed request. Servers compare it without parameters.</summary>
    public const string MediaType = "application/jose+json";

    /// <param name="key">The key that signs.</param>
    /// <param name="url">The URL the request goes to, which the server checks against its own.</param>
    /// <param name="nonce">A nonce from the server, or null for the inner JWS of a key change.</param>
    /// <param name="keyId">The account URL, or null to embed the public key instead.</param>
    /// <param name="payload">The JSON payload, or empty for a POST-as-GET.</param>
    public static byte[] Sign(AcmeAccountKey key, Uri url, string? nonce, Uri? keyId, ReadOnlySpan<byte> payload)
    {
        ArgumentNullException.ThrowIfNull(key);
        ArgumentNullException.ThrowIfNull(url);

        var protectedPart = Base64Url.EncodeToString(Header(key, url, nonce, keyId));
        var payloadPart = Base64Url.EncodeToString(payload);
        var signature = key.Sign(Encoding.ASCII.GetBytes($"{protectedPart}.{payloadPart}"));

        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteString("protected", protectedPart);
            writer.WriteString("payload", payloadPart);
            writer.WriteString("signature", Base64Url.EncodeToString(signature));
            writer.WriteEndObject();
        }

        return buffer.ToArray();
    }

    private static byte[] Header(AcmeAccountKey key, Uri url, string? nonce, Uri? keyId)
    {
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteString("alg", AcmeAccountKey.Algorithm);
            if (keyId is null)
            {
                writer.WritePropertyName("jwk");
                key.Jwk.WriteTo(writer);
            }
            else
            {
                writer.WriteString("kid", keyId.AbsoluteUri);
            }

            if (nonce is not null)
            {
                writer.WriteString("nonce", nonce);
            }

            writer.WriteString("url", url.AbsoluteUri);
            writer.WriteEndObject();
        }

        return buffer.ToArray();
    }
}
