using System.Security.Cryptography;

namespace Runova.ServerCore.Security;

/// <summary>
/// Device keys are ECDSA P-256. The desktop sends the public half as SubjectPublicKeyInfo (DER,
/// base64) and signs with IEEE P1363 (r || s) signatures, the format both Node and .NET produce.
/// </summary>
internal static class DeviceKeys
{
    private const string P256Oid = "1.2.840.10045.3.1.7";

    /// <summary>The key's DER bytes, or null for anything that is not a P-256 public key.</summary>
    public static byte[]? ParsePublicKey(string? base64)
    {
        if (string.IsNullOrWhiteSpace(base64) || base64.Length > 1024)
        {
            return null;
        }

        byte[] der;
        try
        {
            der = Convert.FromBase64String(base64.Trim());
        }
        catch (FormatException)
        {
            return null;
        }

        try
        {
            using var key = ECDsa.Create();
            key.ImportSubjectPublicKeyInfo(der, out var read);
            var curve = key.ExportParameters(includePrivateParameters: false).Curve;
            return read == der.Length && curve.Oid.Value == P256Oid ? der : null;
        }
        catch (CryptographicException)
        {
            return null;
        }
    }

    public static bool Verify(byte[] publicKey, ReadOnlySpan<byte> message, ReadOnlySpan<byte> signature)
    {
        ArgumentNullException.ThrowIfNull(publicKey);
        try
        {
            using var key = ECDsa.Create();
            key.ImportSubjectPublicKeyInfo(publicKey, out _);
            return key.VerifyData(
                message,
                signature,
                HashAlgorithmName.SHA256,
                DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        }
        catch (CryptographicException)
        {
            return false;
        }
    }
}
