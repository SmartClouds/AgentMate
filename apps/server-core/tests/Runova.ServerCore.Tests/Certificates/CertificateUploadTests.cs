using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Runova.ServerCore.Certificates;

namespace Runova.ServerCore.Tests.Certificates;

/// <summary>E11 T5: an uploaded certificate is checked (PEM, chain order, key match, dates, names) before nginx sees it.</summary>
public sealed class CertificateUploadTests
{
    private static readonly DateTimeOffset _now = DateTimeOffset.UtcNow;

    private sealed record Issued(string LeafPem, string IntermediatePem, string RootPem, string KeyPem);

    private static Issued Issue(string[] names, DateTimeOffset? notAfter = null)
    {
        using var rootKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        using var middleKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        using var leafKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var rootRequest = new CertificateRequest("CN=Test Root", rootKey, HashAlgorithmName.SHA256);
        rootRequest.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, false, 0, true));
        using var root = rootRequest.CreateSelfSigned(_now.AddDays(-10), _now.AddYears(5));
        var middleRequest = new CertificateRequest("CN=Test Intermediate", middleKey, HashAlgorithmName.SHA256);
        middleRequest.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, false, 0, true));
        using var middle = middleRequest.Create(root, _now.AddDays(-9), _now.AddYears(4), [1, 2, 3]);
        using var middleWithKey = middle.CopyWithPrivateKey(middleKey);
        var leafRequest = new CertificateRequest($"CN={names[0]}", leafKey, HashAlgorithmName.SHA256);
        var san = new SubjectAlternativeNameBuilder();
        foreach (var name in names)
        {
            san.AddDnsName(name);
        }

        leafRequest.CertificateExtensions.Add(san.Build());
        using var leaf = leafRequest.Create(middleWithKey, _now.AddDays(-1), notAfter ?? _now.AddDays(80), [4, 5, 6]);
        return new Issued(leaf.ExportCertificatePem(), middle.ExportCertificatePem(), root.ExportCertificatePem(), leafKey.ExportPkcs8PrivateKeyPem());
    }

    private static (UploadedCertificate Result, List<string> Problems) Check(string chain, string key, params string[] domains)
    {
        var problems = new List<string>();
        return (CertificateUpload.Check(chain, key, domains, _now, problems), problems);
    }

    [Fact]
    public void A_chain_in_any_order_comes_out_leaf_first()
    {
        var issued = Issue(["shop.example.com", "www.shop.example.com"]);

        var (result, problems) = Check(issued.RootPem + issued.LeafPem + issued.IntermediatePem, issued.KeyPem, "shop.example.com", "www.shop.example.com");

        Assert.True(problems.Count == 0, string.Join(" | ", problems));
        var chain = new X509Certificate2Collection();
        chain.ImportFromPem(result.ChainPem);
        Assert.Equal(["CN=shop.example.com", "CN=Test Intermediate", "CN=Test Root"], chain.Select(c => c.Subject));
        Assert.Equal(("EcdsaP256", "Test Intermediate"), (result.KeyType, result.Issuer));
        Assert.NotEmpty(result.PrivateKeyPkcs8);
    }

    [Fact]
    public void A_key_that_belongs_to_no_certificate_is_refused()
    {
        var issued = Issue(["shop.example.com"]);
        var other = Issue(["shop.example.com"]);

        var (_, problems) = Check(issued.LeafPem, other.KeyPem, "shop.example.com");

        Assert.Contains("does not belong", Assert.Single(problems), StringComparison.Ordinal);
    }

    [Fact]
    public void Missing_names_an_unrelated_certificate_and_an_expired_one_are_each_reported()
    {
        var issued = Issue(["shop.example.com"], notAfter: _now.AddDays(-1).AddHours(12));
        var stranger = Issue(["other.example.com"]);

        var (_, problems) = Check(issued.LeafPem + stranger.RootPem, issued.KeyPem, "shop.example.com", "www.shop.example.com");

        Assert.True(problems.Count == 3, string.Join(" | ", problems));
        Assert.Contains(problems, p => p.Contains("not part of the leaf's chain", StringComparison.Ordinal));
        Assert.Contains(problems, p => p.Contains("expired", StringComparison.Ordinal));
        Assert.Contains(problems, p => p.Contains("does not cover www.shop.example.com", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("", "key")]
    [InlineData("-----BEGIN CERTIFICATE-----\nnot base64!\n-----END CERTIFICATE-----\n", "key")]
    [InlineData("chain", "-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----\n")]
    public void Text_that_is_not_usable_pem_is_refused(string chain, string key)
    {
        var issued = Issue(["shop.example.com"]);

        var (_, problems) = Check(chain == "chain" ? issued.LeafPem : chain, key, "shop.example.com");

        Assert.Single(problems);
    }

    [Theory]
    [InlineData("*.example.com", "shop.example.com", true)]
    [InlineData("*.example.com", "a.b.example.com", false)]
    [InlineData("*.example.com", "example.com", false)]
    [InlineData("Shop.Example.com", "shop.example.com", true)]
    public void A_wildcard_covers_one_label(string name, string domain, bool covered) =>
        Assert.Equal(covered, CertificateUpload.Covers(name, domain));
}
