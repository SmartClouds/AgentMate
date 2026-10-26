using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Runova.ServerCore.Tests.Certificates.Acme;

/// <summary>A flattened JWS taken apart the way an ACME server reads it.</summary>
internal sealed class JwsReader
{
    private JwsReader(string protectedPart, string payloadPart, byte[] signature, JsonElement header, byte[] payload)
    {
        ProtectedPart = protectedPart;
        PayloadPart = payloadPart;
        Signature = signature;
        Header = header;
        Payload = payload;
    }

    public string ProtectedPart { get; }

    public string PayloadPart { get; }

    public byte[] Signature { get; }

    /// <summary>The decoded protected header.</summary>
    public JsonElement Header { get; }

    /// <summary>The decoded payload, empty for POST-as-GET.</summary>
    public byte[] Payload { get; }

    public string Algorithm => Header.GetProperty("alg").GetString()!;

    public string? Nonce => Header.TryGetProperty("nonce", out var nonce) ? nonce.GetString() : null;

    public string? Url => Header.TryGetProperty("url", out var url) ? url.GetString() : null;

    public string? KeyId => Header.TryGetProperty("kid", out var kid) ? kid.GetString() : null;

    public JsonElement? Jwk => Header.TryGetProperty("jwk", out var jwk) ? jwk : null;

    public JsonElement PayloadJson => JsonDocument.Parse(Payload).RootElement.Clone();

    public static JwsReader Parse(ReadOnlySpan<byte> body)
    {
        using var document = JsonDocument.Parse(body.ToArray());
        var root = document.RootElement;
        var names = root.EnumerateObject().Select(property => property.Name).Order(StringComparer.Ordinal);
        Assert.Equal(["payload", "protected", "signature"], names);

        var protectedPart = root.GetProperty("protected").GetString()!;
        var payloadPart = root.GetProperty("payload").GetString()!;
        var signature = Base64Url.DecodeFromChars(root.GetProperty("signature").GetString());
        using var header = JsonDocument.Parse(Base64Url.DecodeFromChars(protectedPart));
        return new JwsReader(
            protectedPart,
            payloadPart,
            signature,
            header.RootElement.Clone(),
            Base64Url.DecodeFromChars(payloadPart));
    }

    /// <summary>A P-256 public key from a JWK object with crv, kty, x and y.</summary>
    public static ECDsa ImportJwk(JsonElement jwk)
    {
        Assert.Equal("EC", jwk.GetProperty("kty").GetString());
        Assert.Equal("P-256", jwk.GetProperty("crv").GetString());
        return ECDsa.Create(new ECParameters
        {
            Curve = ECCurve.NamedCurves.nistP256,
            Q = new ECPoint
            {
                X = Base64Url.DecodeFromChars(jwk.GetProperty("x").GetString()),
                Y = Base64Url.DecodeFromChars(jwk.GetProperty("y").GetString()),
            },
        });
    }

    /// <summary>ES256 over ASCII(protected "." payload), with the 64-byte r || s signature.</summary>
    public bool VerifyWith(ECDsa publicKey) =>
        Signature.Length == 64
        && publicKey.VerifyData(
            Encoding.ASCII.GetBytes($"{ProtectedPart}.{PayloadPart}"),
            Signature,
            HashAlgorithmName.SHA256,
            DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
}
