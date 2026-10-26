using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace Runova.ServerCore.SystemTests.Nginx;

/// <summary>A throwaway certificate authority and the certificates the harness serves with.</summary>
/// <param name="AuthorityPem">The CA certificate curl and nginx's upstream checks trust.</param>
/// <param name="SitesCertificatePem">For every TLS variant's domains, used by nginx.</param>
/// <param name="BackendCertificatePem">For the remote upstream's name, used by the stand-in app.</param>
internal sealed record HarnessCertificates(
    string AuthorityPem,
    string SitesCertificatePem,
    string SitesKeyPem,
    string BackendCertificatePem,
    string BackendKeyPem)
{
    public static HarnessCertificates Create(IReadOnlyList<string> siteNames, string backendName)
    {
        var now = DateTimeOffset.UtcNow;
        using var authorityKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var request = new CertificateRequest("CN=Runova nginx harness CA", authorityKey, HashAlgorithmName.SHA256);
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, false, 0, true));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.KeyCertSign | X509KeyUsageFlags.CrlSign, true));
        request.CertificateExtensions.Add(new X509SubjectKeyIdentifierExtension(request.PublicKey, false));
        using var authority = request.CreateSelfSigned(now.AddDays(-1), now.AddDays(30));

        var (sitesCertificate, sitesKey) = Issue(authority, siteNames, now);
        var (backendCertificate, backendKey) = Issue(authority, [backendName], now);
        return new HarnessCertificates(authority.ExportCertificatePem() + "\n", sitesCertificate, sitesKey, backendCertificate, backendKey);
    }

    private static (string Certificate, string Key) Issue(X509Certificate2 authority, IReadOnlyList<string> names, DateTimeOffset now)
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var request = new CertificateRequest($"CN={names[0]}", key, HashAlgorithmName.SHA256);
        var alternativeNames = new SubjectAlternativeNameBuilder();
        foreach (var name in names)
        {
            alternativeNames.AddDnsName(name);
        }

        request.CertificateExtensions.Add(alternativeNames.Build());
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, false));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature, true));
        request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension([new Oid("1.3.6.1.5.5.7.3.1")], false));
        request.CertificateExtensions.Add(X509AuthorityKeyIdentifierExtension.CreateFromCertificate(authority, true, false));

        var serial = RandomNumberGenerator.GetBytes(16);
        serial[0] &= 0x7f;
        using var certificate = request.Create(authority, now.AddDays(-1), now.AddDays(29), serial);
        return (certificate.ExportCertificatePem() + "\n", key.ExportPkcs8PrivateKeyPem() + "\n");
    }
}
