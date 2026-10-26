using Runova.ServerCore.Nginx;

namespace Runova.ServerCore.Tests.Nginx;

/// <summary>
/// What the renderer promises beyond the exact text the golden files pin: HTTP-only until a
/// certificate exists, a default server that answers nothing, snippets in files of their own, and
/// no release at all when anything in the model is refused.
/// </summary>
public sealed class NginxRendererTests
{
    private static readonly NginxLayout _layout = NginxLayout.Debian;

    private static NginxSite Site(string id = "app", params string[] domains) => new()
    {
        Id = id,
        Domains = domains.Length == 0 ? ["app.example.com"] : domains,
        Upstream = new NginxServiceUpstream("web", 3000),
    };

    private static NginxRelease Render(params NginxSite[] sites) =>
        NginxRenderer.Render(new NginxConfiguration(sites, []), _layout, UpstreamPolicy.Default, release: 7);

    private static string SiteFile(NginxRelease release, string id = "app") =>
        release.Files.Single(f => f.Path == $"sites/{id}.conf").Content;

    private static IReadOnlyList<NginxProblem> Refused(NginxConfiguration configuration)
    {
        var error = Assert.Throws<NginxConfigurationException>(
            () => NginxRenderer.Render(configuration, _layout, UpstreamPolicy.Default, release: 7));
        Assert.NotEmpty(error.Problems);
        return error.Problems;
    }

    private static NginxProblem RefusedSite(NginxSite site) => Assert.Single(Refused(new NginxConfiguration([site], [])));

    [Fact]
    public void Every_server_block_of_a_site_logs_to_the_sites_own_files()
    {
        var content = SiteFile(Render(Site() with { Certificate = new NginxCertificate("/etc/ssl/a.pem", "/etc/ssl/a.key") }));

        Assert.Equal(2, CountOf(content, "access_log /var/log/nginx/runova-app.access.log;"));
        Assert.Equal(2, CountOf(content, "error_log /var/log/nginx/runova-app.error.log;"));
        Assert.Equal("/var/log/nginx/runova-app.access.log", _layout.AccessLog("app"));
        Assert.Equal("/var/log/nginx/runova-app.error.log", _layout.ErrorLog("app"));
    }

    private static int CountOf(string text, string part) => text.Split('\n').Count(line => line.Trim() == part);

    [Fact]
    public void A_site_without_a_certificate_is_http_only_and_answers_acme_challenges()
    {
        var content = SiteFile(Render(Site() with { Hsts = new NginxHsts() }));

        Assert.Contains("listen 80;", content, StringComparison.Ordinal);
        Assert.DoesNotContain("443", content, StringComparison.Ordinal);
        Assert.DoesNotContain("Strict-Transport-Security", content, StringComparison.Ordinal);
        Assert.Contains("location ^~ /.well-known/acme-challenge/ {", content, StringComparison.Ordinal);
        Assert.Contains("root /var/www/runova/acme;", content, StringComparison.Ordinal);
        Assert.Contains("proxy_pass http://127.0.0.1:3000;", content, StringComparison.Ordinal);
    }

    [Fact]
    public void With_a_certificate_http_redirects_and_https_serves_with_http2_and_hsts()
    {
        var content = SiteFile(Render(Site() with
        {
            Certificate = new NginxCertificate("/etc/runova/certs/app/fullchain.pem", "/etc/runova/certs/app/privkey.pem"),
            Hsts = new NginxHsts(),
        }));

        Assert.Contains("return 301 https://$host$request_uri;", content, StringComparison.Ordinal);
        Assert.Contains("listen 443 ssl;", content, StringComparison.Ordinal);
        Assert.Contains("http2 on;", content, StringComparison.Ordinal);
        Assert.Contains("ssl_certificate /etc/runova/certs/app/fullchain.pem;", content, StringComparison.Ordinal);
        Assert.Contains("ssl_stapling off;", content, StringComparison.Ordinal);
        Assert.Contains("add_header Strict-Transport-Security \"max-age=31536000\" always;", content, StringComparison.Ordinal);

        var redirect = content.IndexOf("return 301", StringComparison.Ordinal);
        var acme = content.IndexOf("acme-challenge", StringComparison.Ordinal);
        Assert.True(acme < redirect, "The ACME location must stay on plain HTTP next to the redirect.");
    }

    [Fact]
    public void The_default_server_answers_unknown_names_with_nothing_and_refuses_their_handshakes()
    {
        var http = Render().Files.Single(f => f.Path == NginxRenderer.HttpFile).Content;

        Assert.Contains("listen 80 default_server;", http, StringComparison.Ordinal);
        Assert.Contains("listen 443 ssl default_server;", http, StringComparison.Ordinal);
        Assert.Contains("ssl_reject_handshake on;", http, StringComparison.Ordinal);
        Assert.Contains("return 444;", http, StringComparison.Ordinal);
    }

    [Fact]
    public void Nginx_conf_takes_one_include_inside_http_and_one_inside_a_stream_block()
    {
        Assert.Equal("include /etc/nginx/runova/current/http.conf;", NginxLayout.Debian.HttpInclude);
        Assert.Equal("include /etc/nginx/runova/current/stream.conf;", NginxLayout.Debian.StreamInclude);
        Assert.Equal("/etc/ssl/certs/ca-certificates.crt", NginxLayout.Debian.TrustedCertificates);
        Assert.Equal("/etc/pki/tls/certs/ca-bundle.crt", NginxLayout.Rhel.TrustedCertificates);
    }

    [Fact]
    public void Http_conf_includes_each_site_from_this_release_by_name()
    {
        var release = Render(Site("b", "b.example.com"), Site("a", "a.example.com"));
        var http = release.Files.Single(f => f.Path == NginxRenderer.HttpFile).Content;

        Assert.Equal("/etc/nginx/runova/releases/7", release.Directory);
        Assert.Contains("include /etc/nginx/runova/releases/7/sites/b.conf;\ninclude /etc/nginx/runova/releases/7/sites/a.conf;", http, StringComparison.Ordinal);
    }

    [Fact]
    public void Snippets_are_files_of_their_own_so_nginx_errors_point_at_the_users_lines()
    {
        var release = Render(Site() with
        {
            ServerSnippet = "location = /ping {\r\n    return 204;\r\n}\r\n",
            LocationSnippet = "proxy_read_timeout 120s;",
        });

        var server = release.Files.Single(f => f.Path == "snippets/app.server.conf");
        var location = release.Files.Single(f => f.Path == "snippets/app.location.conf");
        Assert.Equal("location = /ping {\n    return 204;\n}\n", server.Content);
        Assert.Equal("proxy_read_timeout 120s;\n", location.Content);
        Assert.Equal(("app", NginxSnippetContext.Server), (server.SiteId, server.Snippet!.Value));
        Assert.Equal(("app", NginxSnippetContext.Location), (location.SiteId, location.Snippet!.Value));

        var content = SiteFile(release);
        Assert.Contains("    include /etc/nginx/runova/releases/7/snippets/app.server.conf;", content, StringComparison.Ordinal);
        Assert.Contains("        include /etc/nginx/runova/releases/7/snippets/app.location.conf;", content, StringComparison.Ordinal);
    }

    [Fact]
    public void A_broken_snippet_stops_the_whole_release_and_names_its_line()
    {
        var problem = RefusedSite(Site() with { LocationSnippet = "proxy_read_timeout 120s;\ninclude /etc/shadow;\n" });

        Assert.Equal("sites[app].locationSnippet", problem.Field);
        Assert.Equal(2, problem.Line);
        Assert.Contains("include", problem.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Basic_auth_users_go_to_a_password_file_in_the_release()
    {
        var hash = Sha512Crypt.Hash("a long enough password");
        var release = Render(Site() with { BasicAuth = new NginxBasicAuth([new NginxBasicAuthUser("maria", hash)], "Team") });

        Assert.Equal($"maria:{hash}\n", release.Files.Single(f => f.Path == "auth/app.htpasswd").Content);
        var content = SiteFile(release);
        Assert.Contains("auth_basic \"Team\";", content, StringComparison.Ordinal);
        Assert.Contains("auth_basic_user_file /etc/nginx/runova/releases/7/auth/app.htpasswd;", content, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("$apr1$abcdefgh$0123456789012345678901")]
    [InlineData("{PLAIN}secret")]
    [InlineData("plain text password")]
    [InlineData("$6$rounds=900000$saltsaltsaltsalt$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1")]
    public void Basic_auth_takes_nothing_but_sha512_crypt_hashes_with_sane_rounds(string hash)
    {
        var problem = RefusedSite(Site() with { BasicAuth = new NginxBasicAuth([new NginxBasicAuthUser("maria", hash)]) });

        Assert.Equal("sites[app].basicAuth.users[0].passwordHash", problem.Field);
    }

    [Theory]
    [InlineData("http://169.254.169.254/latest/meta-data/")]
    [InlineData("http://[fd00:ec2::254]/")]
    [InlineData("http://metadata.google.internal/")]
    [InlineData("http://unix:/run/runova-core/core.sock:/")]
    [InlineData("http://127.0.0.1:7810/")]
    public void Upstreams_at_metadata_services_or_the_core_are_refused(string url)
    {
        var problem = RefusedSite(Site() with { Upstream = new NginxUrlUpstream(url) });

        Assert.Equal("sites[app].upstream", problem.Field);
    }

    [Theory]
    [InlineData(7810)]
    [InlineData(2375)]
    [InlineData(0)]
    [InlineData(70000)]
    public void Service_ports_go_through_the_same_policy(int port)
    {
        var problem = RefusedSite(Site() with { Upstream = new NginxServiceUpstream("web", port) });

        Assert.Equal("sites[app].upstream", problem.Field);
    }

    [Fact]
    public void Two_sites_claiming_one_domain_are_refused_since_nginx_would_only_warn()
    {
        var problems = Refused(new NginxConfiguration([Site("a", "app.example.com"), Site("b", "APP.example.com")], []));

        Assert.Equal("sites[b].domains[0]", Assert.Single(problems).Field);
    }

    [Fact]
    public void Duplicate_site_ids_are_refused()
    {
        var problems = Refused(new NginxConfiguration([Site("a", "a.example.com"), Site("a", "b.example.com")], []));

        Assert.Equal("sites[a].id", Assert.Single(problems).Field);
    }

    [Theory]
    [InlineData("app.example.com;")]
    [InlineData("app.example.com include")]
    [InlineData("app.example.com\n")]
    [InlineData("app.exa{mple.com")]
    [InlineData("\"app.example.com\"")]
    [InlineData("bücher.example")]
    [InlineData("localhost")]
    [InlineData("10.0.0.5")]
    [InlineData("app.example.com.")]
    [InlineData("*")]
    [InlineData("*.com")]
    [InlineData("a.*.example.com")]
    [InlineData("-app.example.com")]
    [InlineData("app.123")]
    [InlineData("")]
    public void Domains_are_checked_again_whoever_sent_them(string domain)
    {
        var problem = RefusedSite(Site("app", domain));

        Assert.Equal("sites[app].domains[0]", problem.Field);
    }

    [Theory]
    [InlineData("xn--bcher-kva.example")]
    [InlineData("*.example.com")]
    [InlineData("App.Example.COM")]
    public void International_wildcard_and_mixed_case_domains_render_in_lowercase(string domain)
    {
        var content = SiteFile(Render(Site("app", domain)));

        Assert.Contains($"server_name {domain.ToLowerInvariant()};", content, StringComparison.Ordinal);
    }

    [Fact]
    public void Hsts_preload_needs_subdomains_and_at_least_a_year()
    {
        var problem = RefusedSite(Site() with { Hsts = new NginxHsts(86_400, IncludeSubdomains: false, Preload: true) });

        Assert.Equal("sites[app].hsts", problem.Field);
        Assert.Contains("preload", problem.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("Strict-Transport-Security", "max-age=1")]
    [InlineData("X-Frame-Options", "ALLOWALL")]
    [InlineData("X Y", "z")]
    [InlineData("X-Y", "")]
    public void Custom_headers_cannot_override_managed_ones_or_be_malformed(string name, string value)
    {
        var problem = RefusedSite(Site() with { ResponseHeaders = [new NginxHeader(name, value)] });

        Assert.StartsWith("sites[app].responseHeaders[0]", problem.Field, StringComparison.Ordinal);
    }

    [Fact]
    public void Stream_proxies_may_not_take_ssh_the_web_ports_or_each_others_ports()
    {
        NginxStreamProxy Tcp(string id, int port) => new()
        {
            Id = id,
            Protocol = NginxStreamProtocol.Tcp,
            ListenPort = port,
            Upstream = new NginxServiceUpstream("db", 5432),
        };

        var problems = Refused(new NginxConfiguration(
            [],
            [Tcp("ssh", 22), Tcp("web", 443), Tcp("core", 7810), Tcp("db", 15432), Tcp("db2", 15432)]));

        Assert.Equal(
            ["streams[ssh].listenPort", "streams[web].listenPort", "streams[core].listenPort", "streams[db2].listenPort"],
            problems.Select(p => p.Field));
    }

    [Fact]
    public void Udp_and_tcp_may_share_a_port_number()
    {
        var streams = new[] { NginxStreamProtocol.Tcp, NginxStreamProtocol.Udp }.Select(protocol => new NginxStreamProxy
        {
            Id = "dns-" + protocol.ToString().ToLowerInvariant(),
            Protocol = protocol,
            ListenPort = 53,
            Upstream = new NginxServiceUpstream("dns", 1053),
        }).ToList();

        var release = NginxRenderer.Render(new NginxConfiguration([], streams), _layout, UpstreamPolicy.Default, 1);
        var stream = release.Files.Single(f => f.Path == NginxRenderer.StreamFile).Content;

        Assert.Contains("listen 53;", stream, StringComparison.Ordinal);
        Assert.Contains("listen 53 udp;", stream, StringComparison.Ordinal);
    }

    [Fact]
    public void A_url_upstream_for_a_stream_or_an_endpoint_for_a_site_is_refused()
    {
        var problems = Refused(new NginxConfiguration(
            [Site() with { Upstream = new NginxEndpointUpstream("127.0.0.1:3000") }],
            [new NginxStreamProxy
            {
                Id = "db",
                Protocol = NginxStreamProtocol.Tcp,
                ListenPort = 5432,
                Upstream = new NginxUrlUpstream("http://127.0.0.1:5432"),
            }]));

        Assert.Equal(["sites[app].upstream", "streams[db].upstream"], problems.Select(p => p.Field));
    }

    [Fact]
    public void Every_problem_in_a_model_is_reported_at_once()
    {
        var problems = Refused(new NginxConfiguration(
            [Site("Bad Id", "ok.example.com") with
            {
                RateLimit = new NginxRateLimit(0, NginxRatePeriod.Second),
                ClientMaxBodySizeMegabytes = -1,
                IpRules = new NginxIpRules(["10.0.0.1/8"], []),
            }],
            []));

        Assert.Equal(
            ["sites[Bad Id].id", "sites[Bad Id].ipRules.allow[0]", "sites[Bad Id].rateLimit", "sites[Bad Id].clientMaxBodySizeMegabytes"],
            problems.Select(p => p.Field));
    }

    [Fact]
    public void The_same_model_always_renders_the_same_bytes()
    {
        var first = NginxRenderer.Render(NginxVariants.All(), _layout, UpstreamPolicy.Default, 3);
        var second = NginxRenderer.Render(NginxVariants.All(), _layout, UpstreamPolicy.Default, 3);

        Assert.Equal(first.Files, second.Files);
    }

    [Fact]
    public void Everything_rendered_reads_back_through_the_parser_as_balanced_nginx()
    {
        var release = NginxRenderer.Render(NginxVariants.All(), _layout, UpstreamPolicy.Default, 3);

        foreach (var file in release.Files.Where(f => f.Path.EndsWith(".conf", StringComparison.Ordinal)))
        {
            var directives = NginxConfigParser.Parse(file.Content);
            Assert.True(file.Content.Length == 0 || directives.Count > 0 || file.Content.TrimStart().StartsWith('#'), file.Path);
            Assert.All(file.Content.Split('\n'), line => Assert.DoesNotContain("\r", line, StringComparison.Ordinal));
        }
    }
}
