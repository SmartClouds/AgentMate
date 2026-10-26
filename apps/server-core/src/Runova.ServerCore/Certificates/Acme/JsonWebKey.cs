using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text.Json;

namespace Runova.ServerCore.Certificates.Acme;

/// <summary>
/// A public key as a JSON Web Key (RFC 7517) with only the members RFC 7638 calls required, kept
/// in lexicographic order. Written out that way it is also the canonical form the thumbprint
/// hashes, so the key in a JWS header and the key behind a key authorization always agree.
/// </summary>
internal sealed class JsonWebKey
{
    private const string P256Oid = "1.2.840.10045.3.1.7";

    private readonly KeyValuePair<string, string>[] _members;

    private JsonWebKey(IEnumerable<KeyValuePair<string, string>> members)
    {
        _members = [.. members.OrderBy(member => member.Key, StringComparer.Ordinal)];
        Thumbprint = Base64Url.EncodeToString(SHA256.HashData(ToCanonicalJson()));
    }

    /// <summary>base64url(SHA-256(canonical JSON)), RFC 7638 section 3.</summary>
    public string Thumbprint { get; }

    /// <summary>A key given as its required members, for key types the client does not sign with.</summary>
    public static JsonWebKey FromRequiredMembers(IReadOnlyDictionary<string, string> members)
    {
        ArgumentNullException.ThrowIfNull(members);
        return new JsonWebKey(members);
    }

    /// <summary>The public half of a P-256 key: crv, kty, x and y (RFC 7518 section 6.2.1).</summary>
    public static JsonWebKey FromEcdsa(ECDsa key)
    {
        ArgumentNullException.ThrowIfNull(key);
        var parameters = key.ExportParameters(includePrivateParameters: false);
        if (parameters.Curve.Oid.Value != P256Oid || parameters.Q.X is not { Length: 32 } || parameters.Q.Y is not { Length: 32 })
        {
            throw new ArgumentException("Only P-256 keys are supported.", nameof(key));
        }

        return new JsonWebKey(
        [
            new("crv", "P-256"),
            new("kty", "EC"),
            new("x", Base64Url.EncodeToString(parameters.Q.X)),
            new("y", Base64Url.EncodeToString(parameters.Q.Y)),
        ]);
    }

    /// <summary>Writes the key as a JSON object, for a "jwk" header or a key-change "oldKey".</summary>
    public void WriteTo(Utf8JsonWriter writer)
    {
        ArgumentNullException.ThrowIfNull(writer);
        writer.WriteStartObject();
        foreach (var (name, value) in _members)
        {
            writer.WriteString(name, value);
        }

        writer.WriteEndObject();
    }

    /// <summary>The UTF-8 JSON object without whitespace, members in lexicographic order.</summary>
    public byte[] ToCanonicalJson()
    {
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            WriteTo(writer);
        }

        return buffer.ToArray();
    }
}
