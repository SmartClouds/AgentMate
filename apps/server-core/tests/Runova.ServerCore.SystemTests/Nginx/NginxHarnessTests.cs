using Runova.ServerCore.Nginx;
using Runova.ServerCore.Tests.Nginx;

namespace Runova.ServerCore.SystemTests.Nginx;

/// <summary>
/// Starts the nginx harness for one distribution when a test first asks for it, so a machine
/// without Docker skips the tests instead of failing in the fixture, and removes it afterwards.
/// </summary>
public abstract class NginxHarnessFixture(string distro) : IAsyncLifetime
{
    private readonly Lock _lock = new();
    private Task<NginxHarness>? _start;

    public ValueTask InitializeAsync() => ValueTask.CompletedTask;

    public async ValueTask DisposeAsync()
    {
        GC.SuppressFinalize(this);
        if (_start is { IsCompletedSuccessfully: true })
        {
            await (await _start).DisposeAsync();
        }
    }

    internal Task<NginxHarness> GetAsync()
    {
        lock (_lock)
        {
            // Not tied to one test's token: every test in the class shares the one harness.
            return _start ??= NginxHarness.StartAsync(distro, CancellationToken.None);
        }
    }
}

public sealed class DebianNginxFixture() : NginxHarnessFixture("debian-13");

public sealed class RockyNginxFixture() : NginxHarnessFixture("rocky-9");

public sealed class DebianNginxHarnessTests(DebianNginxFixture fixture) : NginxHarnessTests(fixture), IClassFixture<DebianNginxFixture>;

public sealed class RockyNginxHarnessTests(RockyNginxFixture fixture) : NginxHarnessTests(fixture), IClassFixture<RockyNginxFixture>;

/// <summary>
/// E10's acceptance criteria against real nginx.org packages: every renderer variant passes
/// <c>nginx -t</c>, all of them load together and serve through the upstream (checked with curl),
/// and a broken snippet is refused before anything reaches nginx.
/// </summary>
public abstract class NginxHarnessTests(NginxHarnessFixture fixture)
{
    private static readonly string _acmePath = $"/.well-known/acme-challenge/{NginxHarness.AcmeToken}";

    private static string[] Http(string host, string path = "/") =>
        ["--resolve", $"{host}:80:127.0.0.1", $"http://{host}{path}"];

    private static string[] Https(string host, string path = "/") =>
        ["--cacert", NginxHarness.AuthorityPath, "--resolve", $"{host}:443:127.0.0.1", $"https://{host}{path}"];

    [Fact]
    public async Task Every_renderer_variant_passes_nginx_t_on_its_own()
    {
        DockerCli.RequireAvailable();
        var cancellationToken = TestContext.Current.CancellationToken;
        var nginx = await fixture.GetAsync();

        var failures = new List<string>();
        foreach (var variant in NginxVariants.Names)
        {
            var release = await nginx.InstallAsync(NginxVariants.Get(variant), cancellationToken, NginxVariants.Layout(variant, nginx.Layout));
            var result = await nginx.TestConfigurationAsync(cancellationToken);
            if (Problem(result, variant) is { } problem)
            {
                failures.Add($"{variant} (release {release.Number}): {problem}");
            }
        }

        Assert.True(failures.Count == 0, $"nginx -t failed on {nginx.Distro} ({nginx.NginxVersion}):\n{string.Join("\n\n", failures)}");
    }

    [Fact]
    public async Task All_variants_load_together_and_serve_through_the_upstream()
    {
        DockerCli.RequireAvailable();
        var ct = TestContext.Current.CancellationToken;
        var nginx = await fixture.GetAsync();

        // Only this release redirects tls.test, so the wait cannot pass on an older one.
        await nginx.InstallAsync(NginxVariants.All(), ct);
        Assert.Null(Problem(await nginx.TestConfigurationAsync(ct), "everything at once"));
        await nginx.ReloadAsync(async () => (await nginx.CurlAsync(ct, Http("tls.test"))).Status == 301, ct);

        // http-only: proxied with the forwarded headers, a forged X-Forwarded-For replaced, the
        // security headers on, no version in Server, and the ACME location served from the webroot.
        var plain = await nginx.CurlAsync(ct, [.. Http("plain.test", "/hello?x=1"), "-H", "X-Forwarded-For: 203.0.113.66"]);
        Assert.Equal(200, plain.Status);
        Assert.Contains("upstream: http\nGET /hello?x=1 HTTP/1.1\n", plain.Body, StringComparison.Ordinal);
        Assert.Contains("Host: plain.test\n", plain.Body, StringComparison.Ordinal);
        Assert.Contains("X-Forwarded-For: 127.0.0.1\n", plain.Body, StringComparison.Ordinal);
        Assert.Contains("X-Forwarded-Proto: http\n", plain.Body, StringComparison.Ordinal);
        Assert.DoesNotContain("203.0.113.66", plain.Body, StringComparison.Ordinal);
        Assert.Equal("nosniff", plain.Header("X-Content-Type-Options"));
        Assert.Equal("SAMEORIGIN", plain.Header("X-Frame-Options"));
        Assert.Equal("strict-origin-when-cross-origin", plain.Header("Referrer-Policy"));
        Assert.Equal("nginx", plain.Header("Server"));
        var challenge = await nginx.CurlAsync(ct, Http("plain.test", _acmePath));
        Assert.Equal(200, challenge.Status);
        Assert.Equal(NginxHarness.AcmeContent, challenge.Body);
        Assert.Equal(200, (await nginx.CurlAsync(ct, Http("v4.test"))).Status);

        // The default server: unknown names get no answer, and no certificate over TLS.
        var unknown = await nginx.CurlAsync(ct, Http("unknown.test"));
        Assert.Equal((52, 0), (unknown.ExitCode, unknown.Status));
        var unknownTls = await nginx.CurlAsync(ct, Https("unknown.test"));
        Assert.NotEqual(0, unknownTls.ExitCode);
        Assert.Equal(0, unknownTls.Status);

        // tls: HTTP redirects (but still answers ACME), HTTPS serves over HTTP/2 with HSTS.
        var redirect = await nginx.CurlAsync(ct, Http("tls.test", "/x?y=1"));
        Assert.Equal(301, redirect.Status);
        Assert.Equal("https://tls.test/x?y=1", redirect.Header("Location"));
        Assert.Equal(NginxHarness.AcmeContent, (await nginx.CurlAsync(ct, Http("tls.test", _acmePath))).Body);
        var secure = await nginx.CurlAsync(ct, Https("www.tls.test"));
        Assert.Equal(200, secure.Status);
        Assert.Contains("X-Forwarded-Proto: https\n", secure.Body, StringComparison.Ordinal);
        Assert.Equal("max-age=31536000; includeSubDomains", secure.Header("Strict-Transport-Security"));
        Assert.Equal("2", await HttpVersionAsync(nginx, "tls.test", ct));

        // tls-no-redirect: both schemes serve, HTTP/1.1 only, stapling switched on.
        Assert.Equal(200, (await nginx.CurlAsync(ct, Http("open.test"))).Status);
        Assert.Equal(200, (await nginx.CurlAsync(ct, Https("open.test"))).Status);
        Assert.Equal("1.1", await HttpVersionAsync(nginx, "open.test", ct));

        // websocket: the upgrade reaches the app and comes back as 101; a site without the
        // option does not pass Upgrade on.
        string[] upgrade =
        [
            "-i", "-N", "-H", "Connection: Upgrade", "-H", "Upgrade: websocket",
            "-H", "Sec-WebSocket-Version: 13", "-H", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        ];
        var socket = await nginx.CurlRawAsync(ct, [.. upgrade, .. Http("ws.test")]);
        Assert.Contains("HTTP/1.1 101 Switching Protocols", socket.Output, StringComparison.Ordinal);
        Assert.Contains("Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=", socket.Output, StringComparison.Ordinal);
        Assert.Contains("HTTP/1.1 200 OK", (await nginx.CurlRawAsync(ct, [.. upgrade, .. Http("plain.test")])).Output, StringComparison.Ordinal);

        // proxy-cache: a miss, then a hit; session cookies and Authorization skip the cache.
        Assert.Equal("MISS", (await nginx.CurlAsync(ct, Http("cache.test", "/cached"))).Header("X-Cache-Status"));
        Assert.Equal("HIT", (await nginx.CurlAsync(ct, Http("cache.test", "/cached"))).Header("X-Cache-Status"));
        Assert.Equal("BYPASS", (await nginx.CurlAsync(ct, [.. Http("cache.test", "/cached"), "-H", "Cookie: session=1"])).Header("X-Cache-Status"));
        Assert.Equal("BYPASS", (await nginx.CurlAsync(ct, [.. Http("cache.test", "/cached"), "-H", "Authorization: Bearer x"])).Header("X-Cache-Status"));

        // gzip: compressed where switched on, not elsewhere.
        var zipped = await nginx.CurlAsync(ct, ["--compressed", .. Http("gzip.test", "/big")]);
        Assert.Equal("gzip", zipped.Header("Content-Encoding"));
        Assert.Contains("0123456789abcdef", zipped.Body, StringComparison.Ordinal);
        Assert.Equal(string.Empty, (await nginx.CurlAsync(ct, ["--compressed", .. Http("plain.test", "/big")])).Header("Content-Encoding"));

        // ip-rules: 127.0.0.1 is not on the allow list, but ACME challenges still get through.
        Assert.Equal(403, (await nginx.CurlAsync(ct, Http("guarded.test"))).Status);
        Assert.Equal(200, (await nginx.CurlAsync(ct, Http("guarded.test", _acmePath))).Status);

        // basic-auth: the SHA-512 crypt hash made in-house works with nginx's crypt().
        var anonymous = await nginx.CurlAsync(ct, Http("auth.test"));
        Assert.Equal(401, anonymous.Status);
        Assert.Equal("Basic realm=\"Staff only\"", anonymous.Header("WWW-Authenticate"));
        Assert.Equal(401, (await nginx.CurlAsync(ct, ["-u", $"{NginxVariants.User}:not-the-password", .. Http("auth.test")])).Status);
        var signedIn = await nginx.CurlAsync(ct, ["-u", $"{NginxVariants.User}:{NginxVariants.Password}", .. Http("auth.test")]);
        Assert.Equal(200, signedIn.Status);
        Assert.Contains("upstream: http", signedIn.Body, StringComparison.Ordinal);
        Assert.Equal(200, (await nginx.CurlAsync(ct, Http("auth.test", _acmePath))).Status);

        // rate-limit: one request a minute, so the second is turned away.
        Assert.Equal(200, (await nginx.CurlAsync(ct, Http("limited.test"))).Status);
        Assert.Equal(429, (await nginx.CurlAsync(ct, Http("limited.test"))).Status);

        // headers-and-limits: the chosen headers, and the 1 MB body limit.
        var headers = await nginx.CurlAsync(ct, Http("headers.test"));
        Assert.Equal("DENY", headers.Header("X-Frame-Options"));
        Assert.Equal("no-referrer", headers.Header("Referrer-Policy"));
        Assert.Equal("runova", headers.Header("X-Served-By"));
        Assert.Equal("no-store", headers.Header("Cache-Control"));
        Assert.Equal("413", await PostAsync(nginx, "headers.test", 2 * 1024 * 1024, ct));
        Assert.Equal("200", await PostAsync(nginx, "headers.test", 1000, ct));

        // no-security-headers: none at all.
        var bare = await nginx.CurlAsync(ct, Http("bare.test"));
        Assert.Equal(200, bare.Status);
        Assert.Equal(string.Empty, bare.Header("X-Content-Type-Options") + bare.Header("X-Frame-Options") + bare.Header("Referrer-Policy"));

        // url-http and url-https: the remote app, with the URL's path, and verified TLS upstream.
        var remote = await nginx.CurlAsync(ct, Http("url.test", "/x"));
        Assert.Contains("upstream: http\nGET /app/x HTTP/1.1\n", remote.Body, StringComparison.Ordinal);
        Assert.Contains("Host: url.test\n", remote.Body, StringComparison.Ordinal);
        var remoteTls = await nginx.CurlAsync(ct, Http("secure-url.test", "/y"));
        Assert.Contains("upstream: https\nGET /y HTTP/1.1\n", remoteTls.Body, StringComparison.Ordinal);
        Assert.Contains($"Host: {NginxVariants.RemoteHost}:{NginxVariants.RemoteHttpsPort}\n", remoteTls.Body, StringComparison.Ordinal);

        // snippets: nginx answers the health check, serves the site folder, and the location
        // snippet's own add_header keeps the security headers.
        var health = await nginx.CurlAsync(ct, Http("snippets.test", "/healthz"));
        Assert.Equal((200, "healthy"), (health.Status, health.Body));
        Assert.Equal(NginxHarness.StaticContent, (await nginx.CurlAsync(ct, Http("snippets.test", "/static/hello.txt"))).Body);
        var snippet = await nginx.CurlAsync(ct, Http("snippets.test"));
        Assert.Contains("X-From-Snippet: yes\n", snippet.Body, StringComparison.Ordinal);
        Assert.Equal("on", snippet.Header("X-Location-Snippet"));
        Assert.Equal("nosniff", snippet.Header("X-Content-Type-Options"));

        // wildcard: the bare domain and any name under it.
        Assert.Equal(200, (await nginx.CurlAsync(ct, Http("wild.test"))).Status);
        Assert.Contains("Host: anything.wild.test\n", (await nginx.CurlAsync(ct, Http("anything.wild.test"))).Body, StringComparison.Ordinal);

        // everything: all options on one TLS site.
        Assert.Equal(301, (await nginx.CurlAsync(ct, Http("all.test"))).Status);
        Assert.Equal(401, (await nginx.CurlAsync(ct, Https("all.test"))).Status);
        var everything = await nginx.CurlAsync(ct, ["-u", $"{NginxVariants.User}:{NginxVariants.Password}", "--compressed", .. Https("all.test", "/big")]);
        Assert.Equal(200, everything.Status);
        Assert.Equal("max-age=63072000; includeSubDomains; preload", everything.Header("Strict-Transport-Security"));
        Assert.Equal("BYPASS", everything.Header("X-Cache-Status"));
        Assert.Equal("runova", everything.Header("X-Served-By"));
        Assert.Equal("gzip", everything.Header("Content-Encoding"));
        Assert.Contains("X-Everything: yes\n", everything.Body, StringComparison.Ordinal);

        // stream-tcp: bytes pass straight through; the allowlisted port shuts 127.0.0.1 out.
        var tcp = await nginx.CurlAsync(ct, $"http://127.0.0.1:{NginxVariants.TcpPort}/through");
        Assert.Contains("GET /through HTTP/1.1\n", tcp.Body, StringComparison.Ordinal);
        Assert.Contains($"Host: 127.0.0.1:{NginxVariants.TcpPort}\n", tcp.Body, StringComparison.Ordinal);
        var guarded = await nginx.CurlAsync(ct, $"http://127.0.0.1:{NginxVariants.GuardedTcpPort}/");
        Assert.True(guarded.Status == 0 && guarded.ExitCode != 0, guarded.Describe());

        // stream-udp: a datagram goes to the app and its answer comes back.
        var udp = await nginx.ShellAsync(
            "timeout 5 bash -c 'exec 3<>/dev/udp/127.0.0.1/$0; printf ping >&3; head -c 9 <&3' \"$1\"",
            ct,
            NginxVariants.UdpPort.ToString(System.Globalization.CultureInfo.InvariantCulture));
        Assert.Equal("echo:ping", udp.Output);
    }

    [Fact]
    public async Task A_broken_snippet_is_refused_before_it_reaches_nginx()
    {
        DockerCli.RequireAvailable();
        var ct = TestContext.Current.CancellationToken;
        var nginx = await fixture.GetAsync();
        var working = NginxVariants.Get("http-only");
        // Only this release serves plain.test without tls.test, so the wait cannot pass on an older one.
        await nginx.InstallAsync(working, ct);
        Assert.Null(Problem(await nginx.TestConfigurationAsync(ct), "http-only"));
        await nginx.ReloadAsync(
            async () => (await nginx.CurlAsync(ct, Http("plain.test"))).Status == 200
                && (await nginx.CurlAsync(ct, Http("tls.test"))).Status == 0,
            ct);
        var current = await nginx.CurrentTargetAsync(ct);

        var broken = working with
        {
            Sites = [working.Sites[0] with { ServerSnippet = "location /files/ {\n    include /etc/shadow;\n}\n" }],
        };
        var refused = await Assert.ThrowsAsync<NginxConfigurationException>(() => nginx.InstallAsync(broken, ct));

        var problem = Assert.Single(refused.Problems);
        Assert.Equal(("sites[plain].serverSnippet", 2), (problem.Field, problem.Line));
        Assert.Equal(current, await nginx.CurrentTargetAsync(ct));
        Assert.Equal(200, (await nginx.CurlAsync(ct, Http("plain.test"))).Status);
    }

    /// <summary>What is wrong with an nginx -t run, or null when it passed cleanly.</summary>
    private static string? Problem(DockerResult result, string variant)
    {
        if (!result.Succeeded || !result.Error.Contains("test is successful", StringComparison.Ordinal))
        {
            return result.Describe();
        }

        // Stapling is switched on for one variant, and nginx warns that a self-signed test
        // certificate has no OCSP responder. Any other warning is a problem.
        var warnings = result.Error.Split('\n')
            .Where(line => line.Contains("[warn]", StringComparison.Ordinal))
            .Where(line => !(variant is "tls-no-redirect" or "everything at once" && line.Contains("ssl_stapling", StringComparison.Ordinal)))
            .ToList();
        return warnings.Count == 0 ? null : string.Join('\n', warnings);
    }

    private static async Task<string> HttpVersionAsync(NginxHarness nginx, string host, CancellationToken ct) =>
        (await nginx.CurlRawAsync(ct, ["--http2", "-o", "/dev/null", "-w", "%{http_version}", .. Https(host)])).Output;

    private static async Task<string> PostAsync(NginxHarness nginx, string host, int bytes, CancellationToken ct) =>
        (await nginx.ShellAsync(
            "head -c \"$1\" /dev/zero | curl -sS -m 10 -o /dev/null -w '%{http_code}' --resolve \"$2:80:127.0.0.1\" --data-binary @- \"http://$2/\"",
            ct,
            bytes.ToString(System.Globalization.CultureInfo.InvariantCulture),
            host)).Output;
}
