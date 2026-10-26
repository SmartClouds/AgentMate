using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Nginx;
using Runova.ServerCore.Security;
using Runova.ServerCore.Tests.Web;

namespace Runova.ServerCore.Tests.Cloudflare;

/// <summary>
/// E14 T5: an Origin CA certificate for a key made on the server. Only the signing request leaves;
/// the certificate signed for it comes back, is checked against the key and the site's domains,
/// and nginx serves it. A certificate for any other key is refused.
/// </summary>
public sealed class HubOriginCertificateTests
{
    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    /// <summary>Signs a request the way Cloudflare's Origin CA does: the leaf alone, under its own root.</summary>
    private static string Sign(string csrPem, DateTimeOffset? notAfter = null)
    {
        using var rootKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var rootRequest = new CertificateRequest("CN=CloudFlare Origin SSL ECC Certificate Authority, O=\"CloudFlare, Inc.\"", rootKey, HashAlgorithmName.SHA256);
        rootRequest.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, false, 0, true));
        using var root = rootRequest.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-2), DateTimeOffset.UtcNow.AddYears(20));
        var csr = CertificateRequest.LoadSigningRequestPem(csrPem, HashAlgorithmName.SHA256, CertificateRequestLoadOptions.UnsafeLoadCertificateExtensions);
        using var leaf = csr.Create(root, DateTimeOffset.UtcNow.AddDays(-1), notAfter ?? DateTimeOffset.UtcNow.AddYears(15), RandomNumberGenerator.GetBytes(12));
        return leaf.ExportCertificatePem();
    }

    private static async Task<(AuthHarness Harness, HubConnection Hub)> StartAsync()
    {
        var harness = await AuthHarness.CreateAsync(CoreRoles.Admin);
        var hub = await WebHubTests.ConnectAsync(harness);
        await WebHubTests.SetUpNginxAsync(harness, hub);
        var site = WebHubTests.Blog() with { Domains = ["blog.example.com", "*.blog.example.com"] };
        Assert.Empty((await hub.InvokeAsync<SiteSaveResult>(nameof(ICoreHub.SaveSite), site, Cancel)).Problems);
        return (harness, hub);
    }

    [Fact]
    public async Task The_key_stays_on_the_server_and_the_signed_certificate_goes_live()
    {
        var (harness, hub) = await StartAsync();
        await using var _ = harness;
        await using var __ = hub;

        var request = await hub.InvokeAsync<OriginCertificateRequestInfo>(nameof(ICoreHub.CreateOriginCertificateRequest), "blog", Cancel);
        var csr = CertificateRequest.LoadSigningRequestPem(request.CsrPem, HashAlgorithmName.SHA256, CertificateRequestLoadOptions.UnsafeLoadCertificateExtensions);
        var names = csr.CertificateExtensions.OfType<X509SubjectAlternativeNameExtension>().Single().EnumerateDnsNames();

        Assert.Equal("origin-ecc", request.RequestType);
        Assert.Equal(["blog.example.com", "*.blog.example.com"], request.Hostnames);
        Assert.Equal(request.Hostnames, names);
        Assert.DoesNotContain("PRIVATE KEY", request.CsrPem, StringComparison.Ordinal);

        var installed = await hub.InvokeAsync<CertificateUploadResult>(
            nameof(ICoreHub.InstallOriginCertificate), new OriginCertificateInstall("blog", Sign(request.CsrPem)), Cancel);

        Assert.Empty(installed.Problems);
        Assert.Equal((CertificateSource.CloudflareOrigin, false), (installed.Certificate!.Source, installed.Certificate.AutoRenew));
        Assert.Contains("CloudFlare Origin SSL ECC Certificate Authority", installed.Certificate.Issuer, StringComparison.Ordinal);
        Assert.True(installed.Apply!.Applied, installed.Apply.Error);
        var nginx = harness.Services.GetRequiredService<SimulatedNginxMachine>();
        Assert.Contains("listen 443 ssl;", nginx.Text("/etc/nginx/runova/current/sites/blog.conf"), StringComparison.Ordinal);

        await using var scope = harness.Services.CreateAsyncScope();
        Assert.Empty(await scope.ServiceProvider.GetRequiredService<CoreDbContext>().OriginCertificateKeys.ToListAsync(Cancel));
    }

    [Fact]
    public async Task A_certificate_for_another_key_or_without_a_request_is_refused()
    {
        var (harness, hub) = await StartAsync();
        await using var _ = harness;
        await using var __ = hub;
        using var otherKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var otherRequest = new CertificateRequest("CN=blog.example.com", otherKey, HashAlgorithmName.SHA256);
        var sans = new SubjectAlternativeNameBuilder();
        sans.AddDnsName("blog.example.com");
        sans.AddDnsName("*.blog.example.com");
        otherRequest.CertificateExtensions.Add(sans.Build());
        var foreign = Sign(otherRequest.CreateSigningRequestPem());

        var withoutRequest = await hub.InvokeAsync<CertificateUploadResult>(nameof(ICoreHub.InstallOriginCertificate), new OriginCertificateInstall("blog", foreign), Cancel);
        await hub.InvokeAsync<OriginCertificateRequestInfo>(nameof(ICoreHub.CreateOriginCertificateRequest), "blog", Cancel);
        var otherKeyResult = await hub.InvokeAsync<CertificateUploadResult>(nameof(ICoreHub.InstallOriginCertificate), new OriginCertificateInstall("blog", foreign), Cancel);
        var missingSite = await Assert.ThrowsAsync<HubException>(() =>
            hub.InvokeAsync<OriginCertificateRequestInfo>(nameof(ICoreHub.CreateOriginCertificateRequest), "nope", Cancel));

        Assert.Contains("no key waiting", Assert.Single(withoutRequest.Problems), StringComparison.Ordinal);
        Assert.Contains("The private key does not belong to any of the certificates.", otherKeyResult.Problems);
        Assert.Empty(await hub.InvokeAsync<CertificateInfo[]>(nameof(ICoreHub.ListCertificates), Cancel));
        Assert.Contains("no such site", missingSite.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_request_older_than_an_hour_has_to_be_made_again()
    {
        var (harness, hub) = await StartAsync();
        await using var _ = harness;
        await using var __ = hub;
        var request = await hub.InvokeAsync<OriginCertificateRequestInfo>(nameof(ICoreHub.CreateOriginCertificateRequest), "blog", Cancel);

        harness.Clock!.Advance(TimeSpan.FromHours(2));
        var late = await hub.InvokeAsync<CertificateUploadResult>(nameof(ICoreHub.InstallOriginCertificate), new OriginCertificateInstall("blog", Sign(request.CsrPem)), Cancel);

        Assert.Contains("more than an hour old", Assert.Single(late.Problems), StringComparison.Ordinal);
    }
}
