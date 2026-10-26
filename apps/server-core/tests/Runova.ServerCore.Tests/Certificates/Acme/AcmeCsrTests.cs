using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Runova.ServerCore.Certificates.Acme;

namespace Runova.ServerCore.Tests.Certificates.Acme;

/// <summary>The CSR sent at finalize (RFC 8555 section 7.4): every name as a SAN, signed by the certificate key.</summary>
public sealed class AcmeCsrTests
{
    [Fact]
    public void Every_domain_is_a_dns_subject_alternative_name_and_the_first_is_the_common_name()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);

        var csr = Load(AcmeCsr.Create(["example.test", "www.example.test", "api.example.test"], key));

        var san = csr.CertificateExtensions.OfType<X509SubjectAlternativeNameExtension>().Single();
        Assert.Equal(["example.test", "www.example.test", "api.example.test"], san.EnumerateDnsNames());
        Assert.False(san.Critical);
        Assert.Equal("CN=example.test", csr.SubjectName.Name);
    }

    [Fact]
    public void A_wildcard_stays_a_wildcard()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);

        var csr = Load(AcmeCsr.Create(["*.example.test", "example.test"], key));

        Assert.Equal(
            ["*.example.test", "example.test"],
            csr.CertificateExtensions.OfType<X509SubjectAlternativeNameExtension>().Single().EnumerateDnsNames());
    }

    [Fact]
    public void An_ecdsa_key_asks_for_digital_signature_only_and_for_server_authentication()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);

        var csr = Load(AcmeCsr.Create(["example.test"], key));

        var usage = csr.CertificateExtensions.OfType<X509KeyUsageExtension>().Single();
        Assert.True(usage.Critical);
        Assert.Equal(X509KeyUsageFlags.DigitalSignature, usage.KeyUsages);
        var extended = csr.CertificateExtensions.OfType<X509EnhancedKeyUsageExtension>().Single();
        Assert.Equal(["1.3.6.1.5.5.7.3.1"], extended.EnhancedKeyUsages.Cast<Oid>().Select(oid => oid.Value));
    }

    [Fact]
    public void An_rsa_key_also_asks_for_key_encipherment()
    {
        using var key = RSA.Create(2048);

        var csr = Load(AcmeCsr.Create(["example.test"], key));

        Assert.Equal(
            X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.KeyEncipherment,
            csr.CertificateExtensions.OfType<X509KeyUsageExtension>().Single().KeyUsages);
    }

    [Fact]
    public void The_csr_carries_the_certificate_key_and_verifies_with_it()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);

        var csr = Load(AcmeCsr.Create(["example.test"], key));

        Assert.Equal(key.ExportSubjectPublicKeyInfo(), csr.PublicKey.ExportSubjectPublicKeyInfo());
    }

    [Fact]
    public void A_first_name_too_long_for_a_common_name_is_left_to_the_san()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var longName = new string('a', 60) + ".example.test";

        var csr = Load(AcmeCsr.Create([longName, "example.test"], key));

        Assert.Equal(string.Empty, csr.SubjectName.Name);
        Assert.Contains(longName, csr.CertificateExtensions.OfType<X509SubjectAlternativeNameExtension>().Single().EnumerateDnsNames());
    }

    [Theory]
    [InlineData("EcdsaP256", "ECDSA", 256)]
    [InlineData("EcdsaP384", "ECDSA", 384)]
    [InlineData("Rsa2048", "RSA", 2048)]
    public void Certificate_keys_come_in_the_offered_types(string type, string algorithm, int size)
    {
        using var key = AcmeCsr.CreateKey(Enum.Parse<AcmeCertificateKeyType>(type));

        Assert.Equal(size, key.KeySize);
        Assert.Equal(algorithm, key is ECDsa ? "ECDSA" : "RSA");
        Assert.NotEmpty(Load(AcmeCsr.Create(["example.test"], key)).CertificateExtensions);
    }

    [Fact]
    public void The_domains_are_checked_like_any_order()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);

        Assert.Throws<ArgumentException>(() => AcmeCsr.Create(["bad name.example"], key));
        Assert.Throws<ArgumentException>(() => AcmeCsr.Create([], key));
    }

    private static CertificateRequest Load(byte[] der) =>
        CertificateRequest.LoadSigningRequest(der, HashAlgorithmName.SHA256, CertificateRequestLoadOptions.UnsafeLoadCertificateExtensions);
}
