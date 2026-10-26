using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace Runova.ServerCore.Certificates.Acme;

/// <summary>
/// Certificate keys and the CSR for finalize: every name as a DNS subject alternative name (which
/// is what CAs issue from), the first as the common name when it fits, key usage for a TLS server.
/// </summary>
internal static class AcmeCsr
{
    /// <summary>X.520 ub-common-name: longer names can only be SANs.</summary>
    private const int MaxCommonNameLength = 64;

    private static readonly Oid _serverAuthentication = new("1.3.6.1.5.5.7.3.1", "Server Authentication");

    /// <summary>A fresh key for one certificate. Never the account key, which CAs refuse (RFC 8555 section 11.1).</summary>
    public static AsymmetricAlgorithm CreateKey(AcmeCertificateKeyType type) => type switch
    {
        AcmeCertificateKeyType.EcdsaP256 => ECDsa.Create(ECCurve.NamedCurves.nistP256),
        AcmeCertificateKeyType.EcdsaP384 => ECDsa.Create(ECCurve.NamedCurves.nistP384),
        AcmeCertificateKeyType.Rsa2048 => RSA.Create(2048),
        _ => throw new ArgumentOutOfRangeException(nameof(type), type, "Unknown certificate key type."),
    };

    /// <summary>A PKCS#10 request (DER) for the names, signed by the certificate key.</summary>
    /// <exception cref="ArgumentException">A name is not a DNS name, or the key is neither ECDSA nor RSA.</exception>
    public static byte[] Create(IReadOnlyList<string> domains, AsymmetricAlgorithm key)
    {
        ArgumentNullException.ThrowIfNull(domains);
        ArgumentNullException.ThrowIfNull(key);
        var names = AcmeIdentifier.ForDomains(domains).Select(identifier => identifier.Value).ToList();

        var subject = new X500DistinguishedNameBuilder();
        if (names[0].Length <= MaxCommonNameLength)
        {
            subject.AddCommonName(names[0]);
        }

        var request = key switch
        {
            ECDsa ecdsa => new CertificateRequest(
                subject.Build(),
                ecdsa,
                ecdsa.KeySize > 256 ? HashAlgorithmName.SHA384 : HashAlgorithmName.SHA256),
            RSA rsa => new CertificateRequest(subject.Build(), rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1),
            _ => throw new ArgumentException("Certificate keys are ECDSA or RSA.", nameof(key)),
        };

        var alternativeNames = new SubjectAlternativeNameBuilder();
        foreach (var name in names)
        {
            alternativeNames.AddDnsName(name);
        }

        request.CertificateExtensions.Add(alternativeNames.Build(critical: false));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(
            key is RSA
                ? X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.KeyEncipherment
                : X509KeyUsageFlags.DigitalSignature,
            critical: true));
        request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension([_serverAuthentication], critical: false));
        return request.CreateSigningRequest();
    }
}
