using System.Security.Cryptography.X509Certificates;
using Runova.ServerCore.Nginx;

namespace Runova.ServerCore.Tests.Nginx;

/// <summary>
/// E14 T6 in nginx: with the origin lock on, every server block of every site trusts
/// CF-Connecting-IP from Cloudflare's networks only, and Authenticated Origin Pulls asks HTTPS
/// clients for Cloudflare's certificate. Without the lock nothing changes.
/// </summary>
public sealed class NginxOriginLockRendererTests
{
    private static readonly NginxLayout _layout = NginxLayout.Debian;

    private static NginxSite Site(bool tls) => new()
    {
        Id = "app",
        Domains = ["app.example.com"],
        Upstream = new NginxServiceUpstream("web", 3000),
        Certificate = tls ? new NginxCertificate("/etc/ssl/a.pem", "/etc/ssl/a.key") : null,
    };

    private static NginxRelease Render(NginxOriginLock? originLock, bool tls = true) =>
        NginxRenderer.Render(new NginxConfiguration([Site(tls)], [], originLock), _layout, UpstreamPolicy.Default, release: 4);

    private static string File(NginxRelease release, string path) => release.Files.Single(f => f.Path == path).Content;

    private static int CountOf(string text, string line) => text.Split('\n').Count(candidate => candidate.Trim() == line);

    [Fact]
    public void The_real_ip_file_trusts_cloudflares_networks_only_and_every_server_block_includes_it()
    {
        var release = Render(new NginxOriginLock(["173.245.48.0/20", "2400:cb00::/32"]));

        var realIp = File(release, NginxCloudflare.RealIpFile);
        Assert.Contains("set_real_ip_from 173.245.48.0/20;", realIp, StringComparison.Ordinal);
        Assert.Contains("set_real_ip_from 2400:cb00::/32;", realIp, StringComparison.Ordinal);
        Assert.Contains("real_ip_header CF-Connecting-IP;", realIp, StringComparison.Ordinal);
        Assert.Equal(2, CountOf(realIp, "set_real_ip_from 173.245.48.0/20;") + CountOf(realIp, "set_real_ip_from 2400:cb00::/32;"));

        var site = File(release, "sites/app.conf");
        Assert.Equal(2, CountOf(site, "include /etc/nginx/runova/releases/4/cloudflare/real-ip.conf;"));
        Assert.DoesNotContain("ssl_verify_client", site, StringComparison.Ordinal);
        Assert.DoesNotContain(release.Files, f => f.Path == NginxCloudflare.OriginPullCaFile);
        Assert.DoesNotContain("real_ip", File(release, NginxRenderer.HttpFile), StringComparison.Ordinal);
    }

    [Fact]
    public void Authenticated_origin_pulls_verify_cloudflares_client_certificate_on_https_only()
    {
        var release = Render(new NginxOriginLock(["173.245.48.0/20"], AuthenticatedOriginPulls: true));

        var site = File(release, "sites/app.conf");
        var https = site[site.IndexOf("listen 443 ssl;", StringComparison.Ordinal)..];
        var http = site[..site.IndexOf("listen 443 ssl;", StringComparison.Ordinal)];
        Assert.Contains("ssl_client_certificate /etc/nginx/runova/releases/4/cloudflare/origin-pull-ca.pem;", https, StringComparison.Ordinal);
        Assert.Contains("ssl_verify_client on;", https, StringComparison.Ordinal);
        Assert.DoesNotContain("ssl_verify_client", http, StringComparison.Ordinal);

        using var ca = X509Certificate2.CreateFromPem(File(release, NginxCloudflare.OriginPullCaFile));
        Assert.Equal("origin-pull.cloudflare.net", ca.GetNameInfo(X509NameType.SimpleName, false));
        Assert.Equal("9A1AC2B4BE15F9F27EEE20A734CBA4E9898F61001B3BD7C84B69B56A3E25A2B9", ca.GetCertHashString(System.Security.Cryptography.HashAlgorithmName.SHA256));
    }

    [Fact]
    public void A_site_without_a_certificate_still_restores_the_address_on_plain_http()
    {
        var site = File(Render(new NginxOriginLock(["173.245.48.0/20"], AuthenticatedOriginPulls: true), tls: false), "sites/app.conf");

        Assert.Equal(1, CountOf(site, "include /etc/nginx/runova/releases/4/cloudflare/real-ip.conf;"));
        Assert.DoesNotContain("ssl_verify_client", site, StringComparison.Ordinal);
    }

    [Fact]
    public void Without_the_lock_nothing_about_cloudflare_is_rendered()
    {
        var release = Render(null);

        Assert.DoesNotContain(release.Files, f => f.Path.StartsWith("cloudflare/", StringComparison.Ordinal));
        Assert.DoesNotContain("real-ip", File(release, "sites/app.conf"), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("173.245.48.1/20")]
    [InlineData("not-a-network")]
    [InlineData("10.0.0.0/8;\ninclude /etc/passwd")]
    public void A_network_that_is_not_canonical_cidr_refuses_the_whole_release(string network)
    {
        var error = Assert.Throws<NginxConfigurationException>(() => Render(new NginxOriginLock([network])));

        Assert.StartsWith("originLock.cloudflareNetworks[0]", Assert.Single(error.Problems).Field, StringComparison.Ordinal);
    }

    [Fact]
    public void A_lock_without_networks_is_refused()
    {
        var error = Assert.Throws<NginxConfigurationException>(() => Render(new NginxOriginLock([])));

        Assert.Equal("originLock", Assert.Single(error.Problems).Field);
    }
}
