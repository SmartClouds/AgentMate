using System.Security.Cryptography;

namespace Runova.ServerCore.Certificates.Acme;

/// <summary>
/// An ACME account key: ECDSA P-256, signing as ES256. The private half stays inside this object;
/// only an account store exports it, to seal it at rest.
/// </summary>
internal sealed class AcmeAccountKey : IDisposable
{
    public const string Algorithm = "ES256";

    private readonly ECDsa _key;

    private AcmeAccountKey(ECDsa key)
    {
        _key = key;
        Jwk = JsonWebKey.FromEcdsa(key);
    }

    /// <summary>The public key as it appears in a "jwk" header.</summary>
    public JsonWebKey Jwk { get; }

    /// <summary>The RFC 7638 thumbprint that every key authorization ends with.</summary>
    public string Thumbprint => Jwk.Thumbprint;

    public static AcmeAccountKey Generate() => new(ECDsa.Create(ECCurve.NamedCurves.nistP256));

    /// <summary>Loads a key an account store saved with <see cref="ExportPkcs8"/>.</summary>
    /// <exception cref="ArgumentException">The bytes hold a key that is not P-256.</exception>
    public static AcmeAccountKey FromPkcs8(ReadOnlySpan<byte> pkcs8)
    {
        var key = ECDsa.Create();
        try
        {
            key.ImportPkcs8PrivateKey(pkcs8, out var read);
            if (read != pkcs8.Length)
            {
                throw new ArgumentException("The account key has trailing data.", nameof(pkcs8));
            }

            return new AcmeAccountKey(key);
        }
        catch
        {
            key.Dispose();
            throw;
        }
    }

    /// <summary>The private key as PKCS#8, for an account store to seal. Nothing else calls this.</summary>
    public byte[] ExportPkcs8() => _key.ExportPkcs8PrivateKey();

    /// <summary>An ES256 signature in the fixed 64-byte r || s form JWS uses (RFC 7518 section 3.4).</summary>
    public byte[] Sign(ReadOnlySpan<byte> data) =>
        _key.SignData(data, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);

    public void Dispose() => _key.Dispose();
}
