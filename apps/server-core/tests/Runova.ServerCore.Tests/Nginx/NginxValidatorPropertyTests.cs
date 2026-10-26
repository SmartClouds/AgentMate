using System.Text.RegularExpressions;
using Runova.ServerCore.Nginx;

namespace Runova.ServerCore.Tests.Nginx;

/// <summary>
/// Property-style checks over many generated inputs (a fixed seed keeps failures repeatable):
/// whatever user text the validators let through can never break out of the value it was written
/// into, and every accepted model renders to configuration that reads back as the same values.
/// </summary>
public sealed class NginxValidatorPropertyTests
{
    private const string Hostile = "aZ09 -_.:/*@%=,+!~()[]<>?&|^`#;{}\"'\\$\t\r\n\0\u00e9\u202e";

    private static readonly NginxLayout _layout = NginxLayout.Debian;

    private static string RandomText(Random random, int maxLength, string alphabet = Hostile)
    {
        var chars = new char[random.Next(0, maxLength + 1)];
        for (var i = 0; i < chars.Length; i++)
        {
            chars[i] = alphabet[random.Next(alphabet.Length)];
        }

        return new string(chars);
    }

    private static NginxSite Site() => new()
    {
        Id = "app",
        Domains = ["app.example.com"],
        Upstream = new NginxServiceUpstream("web", 3000),
    };

    private static bool TryRender(NginxSite site, out NginxRelease release)
    {
        var configuration = new NginxConfiguration([site], []);
        if (NginxValidator.Validate(configuration, _layout, UpstreamPolicy.Default).Count > 0)
        {
            release = null!;
            return false;
        }

        release = NginxRenderer.Render(configuration, _layout, UpstreamPolicy.Default, 1);
        return true;
    }

    private static IEnumerable<NginxDirective> Flatten(IEnumerable<NginxDirective> directives) =>
        directives.SelectMany(d => new[] { d }.Concat(Flatten(d.Block ?? [])));

    private static List<NginxDirective> SiteDirectives(NginxRelease release) =>
        [.. Flatten(NginxConfigParser.Parse(release.Files.Single(f => f.Path == "sites/app.conf").Content))];

    [Fact]
    public void Accepted_header_values_never_carry_config_syntax_and_read_back_unchanged()
    {
        var random = new Random(7001);
        var accepted = 0;
        for (var i = 0; i < 3000; i++)
        {
            var value = RandomText(random, 20);
            if (!TryRender(Site() with { ResponseHeaders = [new NginxHeader("X-Test", value)] }, out var release))
            {
                continue;
            }

            accepted++;
            Assert.DoesNotMatch("[\\x00-\\x1f\\x7f;{}\"'\\\\$]", value);
            var headers = SiteDirectives(release).Where(d => d.Name == "add_header" && d.Arguments[0] == "X-Test").ToList();
            Assert.NotEmpty(headers);
            Assert.All(headers, d => Assert.Equal(["X-Test", value, "always"], d.Arguments));
        }

        Assert.True(accepted > 50, $"Only {accepted} values were accepted.");
    }

    [Fact]
    public void Accepted_realms_read_back_unchanged()
    {
        var random = new Random(7002);
        var hash = Sha512Crypt.Hash("a long enough password");
        var accepted = 0;
        for (var i = 0; i < 3000; i++)
        {
            var realm = RandomText(random, 16);
            if (!TryRender(Site() with { BasicAuth = new NginxBasicAuth([new NginxBasicAuthUser("maria", hash)], realm) }, out var release))
            {
                continue;
            }

            accepted++;
            Assert.NotEqual("off", realm, StringComparer.OrdinalIgnoreCase);
            var directive = SiteDirectives(release).Single(d => d.Name == "auth_basic" && d.Arguments[0] != "off");
            Assert.Equal([realm], directive.Arguments);
        }

        Assert.True(accepted > 50, $"Only {accepted} realms were accepted.");
    }

    [Theory]
    [InlineData("off")]
    [InlineData("OFF")]
    public void A_realm_nginx_would_read_as_switching_auth_off_is_refused(string realm)
    {
        var site = Site() with { BasicAuth = new NginxBasicAuth([new NginxBasicAuthUser("maria", Sha512Crypt.Hash("a long password"))], realm) };

        var problem = Assert.Single(NginxValidator.Validate(new NginxConfiguration([site], []), _layout, UpstreamPolicy.Default));
        Assert.Equal("sites[app].basicAuth.realm", problem.Field);
    }

    [Fact]
    public void Accepted_basic_auth_user_names_cannot_add_lines_or_fields_to_the_password_file()
    {
        var random = new Random(7003);
        var hash = Sha512Crypt.Hash("a long enough password");
        for (var i = 0; i < 3000; i++)
        {
            var name = RandomText(random, 12);
            if (!TryRender(Site() with { BasicAuth = new NginxBasicAuth([new NginxBasicAuthUser(name, hash)]) }, out var release))
            {
                continue;
            }

            var file = release.Files.Single(f => f.Path == "auth/app.htpasswd").Content;
            Assert.Equal($"{name}:{hash}\n", file);
            Assert.DoesNotMatch("[\\s:#]", name);
        }
    }

    [Fact]
    public void Accepted_domains_are_plain_names_and_become_exactly_the_server_names()
    {
        var random = new Random(7004);
        const string alphabet = "abcdefghijklmnopqrstuvwxyzXYZ0123456789.....-*_ ;{}\"'\\$\n\u00e9";
        var accepted = 0;
        for (var i = 0; i < 5000; i++)
        {
            var domain = RandomText(random, 14, alphabet);
            if (!TryRender(Site() with { Domains = [domain] }, out var release))
            {
                continue;
            }

            accepted++;
            Assert.Matches("^(\\*\\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z0-9-]*[a-z][a-z0-9-]*$", domain.ToLowerInvariant());
            Assert.All(
                SiteDirectives(release).Where(d => d.Name == "server_name"),
                d => Assert.Equal([domain.ToLowerInvariant()], d.Arguments));
        }

        Assert.True(accepted > 20, $"Only {accepted} domains were accepted.");
    }

    [Fact]
    public void Accepted_cache_bypass_cookies_are_plain_variable_names()
    {
        var random = new Random(7005);
        for (var i = 0; i < 2000; i++)
        {
            var cookie = RandomText(random, 10);
            if (!TryRender(Site() with { ProxyCache = new NginxProxyCache { BypassCookies = [cookie] } }, out var release))
            {
                continue;
            }

            Assert.Matches("^[A-Za-z0-9_]+$", cookie);
            var bypass = SiteDirectives(release).Single(d => d.Name == "proxy_cache_bypass");
            Assert.Contains("$cookie_" + cookie, bypass.Arguments);
        }
    }

    [Fact]
    public void Accepted_certificate_paths_are_plain_absolute_paths()
    {
        var random = new Random(7006);
        const string alphabet = "abc/._-~ ;{}\"'\\$\n";
        for (var i = 0; i < 3000; i++)
        {
            var path = "/" + RandomText(random, 12, alphabet);
            if (!TryRender(Site() with { Certificate = new NginxCertificate(path, "/etc/runova/key.pem") }, out var release))
            {
                continue;
            }

            Assert.Matches("^(/[A-Za-z0-9._-]+)+$", path);
            Assert.DoesNotMatch("/\\.\\.?(/|$)", path);
            Assert.Equal([path], SiteDirectives(release).Single(d => d.Name == "ssl_certificate").Arguments);
        }
    }

    [Fact]
    public void Random_accepted_models_render_to_nginx_that_reads_back_as_the_model()
    {
        var random = new Random(7007);
        var hash = Sha512Crypt.Hash("a long enough password");
        for (var i = 0; i < 300; i++)
        {
            var hasCertificate = random.Next(2) == 0;
            var redirect = random.Next(2) == 0;
            var site = Site() with
            {
                Domains = [.. Enumerable.Range(0, random.Next(1, 4)).Select(n => $"d{n}.example.com")],
                Certificate = hasCertificate ? new NginxCertificate("/etc/runova/cert.pem", "/etc/runova/key.pem") : null,
                RedirectToHttps = redirect,
                Http2 = random.Next(2) == 0,
                Websocket = random.Next(2) == 0,
                Gzip = random.Next(2) == 0,
                ProxyCache = random.Next(2) == 0 ? new NginxProxyCache() : null,
                Hsts = random.Next(2) == 0 ? new NginxHsts() : null,
                BasicAuth = random.Next(2) == 0 ? new NginxBasicAuth([new NginxBasicAuthUser("maria", hash)]) : null,
                RateLimit = random.Next(2) == 0 ? new NginxRateLimit(random.Next(1, 100), NginxRatePeriod.Second, random.Next(0, 20)) : null,
                IpRules = random.Next(2) == 0 ? new NginxIpRules(["10.0.0.0/8"], ["10.9.9.9"]) : null,
                ClientMaxBodySizeMegabytes = random.Next(2) == 0 ? random.Next(0, 500) : null,
                LocationSnippet = random.Next(2) == 0 ? "proxy_read_timeout 90s;" : null,
            };

            Assert.True(TryRender(site, out var release), $"Model {i} was refused.");
            var directives = SiteDirectives(release);
            var servers = directives.Where(d => d.Name == "server").ToList();
            Assert.Equal(hasCertificate ? 2 : 1, servers.Count);
            Assert.All(
                directives.Where(d => d.Name == "server_name"),
                d => Assert.Equal(site.Domains, d.Arguments));
            Assert.Equal(
                hasCertificate && site.Hsts is not null,
                directives.Any(d => d.Name == "add_header" && d.Arguments[0] == "Strict-Transport-Security"));
            Assert.Equal(
                hasCertificate && redirect,
                directives.Any(d => d.Name == "return" && d.Arguments.SequenceEqual(["301", "https://$host$request_uri"])));
            Assert.All(
                directives.Where(d => d.Name == "proxy_pass"),
                d => Assert.Equal(["http://127.0.0.1:3000"], d.Arguments));
            Assert.DoesNotMatch(new Regex("\\r"), release.Files.Single(f => f.Path == "sites/app.conf").Content);
        }
    }
}
