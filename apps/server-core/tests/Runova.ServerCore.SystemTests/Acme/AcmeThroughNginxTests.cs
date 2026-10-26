using System.Security.Cryptography;
using Microsoft.Extensions.Logging.Abstractions;
using Runova.ServerCore.Certificates;
using Runova.ServerCore.Certificates.Acme;
using Runova.ServerCore.Nginx;
using Runova.ServerCore.SystemTests.Nginx;
using NginxDocker = Runova.ServerCore.SystemTests.Nginx.DockerCli;

namespace Runova.ServerCore.SystemTests.Acme;

/// <summary>Pebble validating HTTP-01 on port 80, which is where a real web server answers.</summary>
public sealed class PebbleOnPort80Fixture() : PebbleFixture(80);

/// <summary>
/// E11 T7: Pebble and challtestsrv wired to the E10 nginx harness. The core's webroot publisher
/// answers HTTP-01 through real nginx, the certificate goes to nginx through the core's apply,
/// the site then serves TLS that verifies against Pebble's root, and a renewal (with "replaces")
/// goes the same way.
/// </summary>
public sealed class AcmeThroughNginxTests(PebbleOnPort80Fixture pebble, DebianNginxFixture nginx)
    : IClassFixture<PebbleOnPort80Fixture>, IClassFixture<DebianNginxFixture>
{
    private const string Domain = "tls.runova.test";
    private const string RootPath = "/etc/runova-test/pebble-root.pem";

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    [Fact]
    public async Task A_certificate_issued_over_http01_through_nginx_is_served_and_renewed()
    {
        Assert.SkipWhen(pebble.SkipReason is not null, pebble.SkipReason ?? string.Empty);
        NginxDocker.RequireAvailable();
        var harness = await nginx.GetAsync();
        var core = NginxApplySystemTests.Connect(harness);
        await JoinPebbleNetworkAsync(harness);

        var site = NginxApplySystemTests.Site("tls-site", Domain) with { BasicAuth = null };
        Assert.True((await core.ApplyAsync(new NginxConfiguration([site], []))).Applied);

        var certificates = new InMemoryAcmeCertificateStore();
        var publisher = new WebrootChallengePublisher(core.Machine, core.Layout);
        var issuer = new AcmeIssuer(pebble.CreateClient(), new InMemoryAcmeAccountStore(), certificates, publisher, null, TimeProvider.System, NullLogger<AcmeIssuer>.Instance);
        (await issuer.EnsureAccountAsync(new AcmeAccountSettings(["ops@runova.test"], TermsOfServiceAgreed: true), Cancel)).Dispose();

        var issued = await issuer.IssueAsync(new AcmeIssueRequest { Name = "tls-site", Domains = [Domain] }, progress: null, Cancel);
        Assert.Equal([NginxHarness.AcmeToken], await core.Machine.ListAsync(core.Layout.AcmeChallengeDirectory, Cancel));

        using var root = await pebble.GetRootAsync(0, Cancel);
        await core.Machine.WriteAsync(RootPath, System.Text.Encoding.ASCII.GetBytes(root.ExportCertificatePem()), UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead | UnixFileMode.OtherRead, Cancel);
        await ServeAsync(core, site, issued);
        var secure = await HttpsAsync(harness);
        Assert.True(secure.Status == 200, secure.Describe());
        Assert.Contains("X-Forwarded-Proto: https", secure.Body, StringComparison.Ordinal);
        Assert.Equal(301, (await harness.CurlAsync(Cancel, "--resolve", $"{Domain}:80:127.0.0.1", $"http://{Domain}/")).Status);

        var renewed = await issuer.RenewAsync("tls-site", progress: null, Cancel);
        await ServeAsync(core, site, renewed);

        Assert.Equal(issued.CertificateId, renewed.Replaced);
        Assert.Equal(200, (await HttpsAsync(harness)).Status);
        var served = await harness.ShellAsync(
            "echo | openssl s_client -connect 127.0.0.1:443 -servername \"$1\" 2>/dev/null | openssl x509 -noout -serial",
            Cancel,
            Domain);
        Assert.Contains(SerialOf(renewed), served.Output.Replace(":", string.Empty, StringComparison.Ordinal), StringComparison.OrdinalIgnoreCase);
    }

    private static string SerialOf(AcmeCertificateRecord record)
    {
        using var leaf = System.Security.Cryptography.X509Certificates.X509Certificate2.CreateFromPem(record.ChainPem);
        return leaf.SerialNumber.TrimStart('0');
    }

    private static async Task ServeAsync(NginxApplySystemTests.Core core, NginxSite site, AcmeCertificateRecord record)
    {
        var key = PemEncoding.WriteString("PRIVATE KEY", record.PrivateKeyPkcs8.Span) + "\n";
        var withTls = site with { Certificate = new NginxCertificate(core.Layout.CertificateFile(site.Id), core.Layout.KeyFile(site.Id)) };
        var outcome = await core.ApplyAsync(new NginxConfiguration([withTls], []), new NginxCertificateFiles(site.Id, record.ChainPem, key));
        Assert.True(outcome.Applied, string.Join("\n", outcome.Problems));
    }

    private static Task<CurlResponse> HttpsAsync(NginxHarness harness) =>
        harness.CurlAsync(Cancel, "--cacert", RootPath, "--resolve", $"{Domain}:443:127.0.0.1", $"https://{Domain}/");

    /// <summary>nginx joins Pebble's network, and challtestsrv points the domain at it there.</summary>
    private async Task JoinPebbleNetworkAsync(NginxHarness harness)
    {
        await NginxDocker.RunAsync(["network", "connect", pebble.Network, harness.Nginx], TimeSpan.FromMinutes(1), Cancel);
        var address = (await NginxDocker.CheckedAsync(
            ["inspect", "--format", $"{{{{(index .NetworkSettings.Networks \"{pebble.Network}\").IPAddress}}}}", harness.Nginx],
            TimeSpan.FromMinutes(1),
            Cancel)).Trim();
        Assert.False(string.IsNullOrEmpty(address));
        await pebble.Challenges.AddAddressAsync(Domain, address, Cancel);
    }
}
