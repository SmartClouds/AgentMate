using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Runova.ServerCore.Certificates.Acme;

namespace Runova.ServerCore.Tests.Certificates.Acme;

/// <summary>
/// ARI names a certificate by base64url(AKI keyIdentifier) "." base64url(serial DER content)
/// (RFC 9773 section 4.1). It is the renewalInfo path and the "replaces" of a renewal.
/// </summary>
public sealed class AcmeCertificateIdTests
{
    // RFC 9773 Appendix A. Its validity dates are in the year 1, which is why the identifier is
    // read from the DER rather than through the platform's certificate parser.
    private const string Rfc9773Example = """
        -----BEGIN CERTIFICATE-----
        MIIBQzCB66ADAgECAgUAh2VDITAKBggqhkjOPQQDAjAVMRMwEQYDVQQDEwpFeGFt
        cGxlIENBMCIYDzAwMDEwMTAxMDAwMDAwWhgPMDAwMTAxMDEwMDAwMDBaMBYxFDAS
        BgNVBAMTC2V4YW1wbGUuY29tMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEeBZu
        7cbpAYNXZLbbh8rNIzuOoqOOtmxA1v7cRm//AwyMwWxyHz4zfwmBhcSrf47NUAFf
        qzLQ2PPQxdTXREYEnKMjMCEwHwYDVR0jBBgwFoAUaYhba4dGQEHhs3uEe6CuLN4B
        yNQwCgYIKoZIzj0EAwIDRwAwRAIge09+S5TZAlw5tgtiVvuERV6cT4mfutXIlwTb
        +FYN/8oCIClDsqBklhB9KAelFiYt9+6FDj3z4KGVelYM5MdsO3pK
        -----END CERTIFICATE-----
        """;

    [Fact]
    public void The_identifier_of_the_rfc_9773_example_certificate_matches_the_rfc()
    {
        var der = PemEncoding.Find(Rfc9773Example) is var fields
            ? Convert.FromBase64String(Rfc9773Example[fields.Base64Data])
            : [];

        Assert.Equal("aYhba4dGQEHhs3uEe6CuLN4ByNQ.AIdlQyE", AcmeCertificateId.FromDer(der));
    }

    [Fact]
    public void A_certificate_object_gives_the_same_identifier_as_its_der()
    {
        using var issuerKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var issuerRequest = new CertificateRequest("CN=Test Issuer", issuerKey, HashAlgorithmName.SHA256);
        issuerRequest.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, false, 0, true));
        issuerRequest.CertificateExtensions.Add(new X509SubjectKeyIdentifierExtension(issuerRequest.PublicKey, false));
        using var issuer = issuerRequest.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(30));
        using var leafKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var leafRequest = new CertificateRequest("CN=example.test", leafKey, HashAlgorithmName.SHA256);
        leafRequest.CertificateExtensions.Add(X509AuthorityKeyIdentifierExtension.CreateFromCertificate(issuer, true, false));
        using var leaf = leafRequest.Create(issuer, DateTimeOffset.UtcNow, DateTimeOffset.UtcNow.AddDays(7), [0x80, 0x01, 0x02]);

        var id = AcmeCertificateId.FromCertificate(leaf);

        var keyId = Convert.FromHexString(issuer.Extensions.OfType<X509SubjectKeyIdentifierExtension>().Single().SubjectKeyIdentifier!);
        Assert.Equal($"{System.Buffers.Text.Base64Url.EncodeToString(keyId)}.AIABAg", id);
        Assert.Equal(AcmeCertificateId.FromDer(leaf.RawData), id);
    }

    [Fact]
    public void A_certificate_without_an_authority_key_identifier_has_no_ari_identifier()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        using var selfSigned = new CertificateRequest("CN=example.test", key, HashAlgorithmName.SHA256)
            .CreateSelfSigned(DateTimeOffset.UtcNow, DateTimeOffset.UtcNow.AddDays(1));

        Assert.Throws<AcmeException>(() => AcmeCertificateId.FromCertificate(selfSigned));
    }

    [Fact]
    public void Garbage_is_not_a_certificate()
    {
        Assert.Throws<AcmeException>(() => AcmeCertificateId.FromDer(new byte[] { 0x30, 0x03, 0x02, 0x01, 0x01 }));
    }

    [Theory]
    [InlineData("aYhba4dGQEHhs3uEe6CuLN4ByNQ.AIdlQyE", true)]
    [InlineData("aYhba4dGQEHhs3uEe6CuLN4ByNQ", false)]
    [InlineData("aYhba4dGQEHhs3uEe6CuLN4ByNQ=.AIdlQyE=", false)]
    [InlineData("a/b.c", false)]
    [InlineData(".AIdlQyE", false)]
    [InlineData("a.b.c", false)]
    public void Only_two_unpadded_base64url_parts_are_an_identifier(string id, bool expected)
    {
        Assert.Equal(expected, AcmeCertificateId.IsWellFormed(id));
    }
}
