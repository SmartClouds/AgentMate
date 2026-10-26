using Runova.ServerCore.Nginx;

namespace Runova.ServerCore.Tests.Nginx;

/// <summary>
/// Every renderer variant, shared by the golden-file tests and the nginx harness (the system tests
/// link this file), so the configuration pinned in the golden files is exactly what real nginx
/// loads and serves. Ids, domains and ports differ between variants so that all of them load
/// together as one release, the way a server with many sites has them.
/// </summary>
internal static class NginxVariants
{
    /// <summary>The stand-in app on 127.0.0.1, where stack services are published.</summary>
    public const int UpstreamPort = 3000;

    public const int UdpUpstreamPort = 5300;

    /// <summary>A second stand-in app elsewhere on the network, for URL upstreams.</summary>
    public const string RemoteHost = "backend.internal";

    public const int RemoteHttpPort = 8080;
    public const int RemoteHttpsPort = 8443;

    public const string CertificatePath = "/etc/runova-test/tls/sites.crt";
    public const string KeyPath = "/etc/runova-test/tls/sites.key";

    public const string User = "alice";
    public const string Password = "wonderland-2026";

    public const int TcpPort = 5000;
    public const int GuardedTcpPort = 5001;
    public const int UdpPort = 5353;

    public const string ServerSnippet =
        """
        # Answered by nginx itself, so a health check works while the app restarts.
        location = /healthz {
            access_log off;
            default_type text/plain;
            return 200 "healthy";
        }

        location /static/ {
            alias /var/www/runova/sites/snippets/static/;
            expires 7d;
        }

        """;

    public const string LocationSnippet =
        """
        proxy_set_header X-From-Snippet yes;
        add_header X-Location-Snippet on always;

        """;

    private static readonly NginxCertificate _certificate = new(CertificatePath, KeyPath);

    /// <summary>A fixed salt keeps the golden files stable; real hashes get a random one.</summary>
    public static string PasswordHash { get; } = Sha512Crypt.Hash(Password, "goldensaltgolden");

    public static IReadOnlyList<string> Names { get; } =
    [
        "empty",
        "http-only",
        "ipv4-only",
        "tls",
        "tls-no-redirect",
        "websocket",
        "proxy-cache",
        "gzip",
        "ip-rules",
        "basic-auth",
        "rate-limit",
        "headers-and-limits",
        "no-security-headers",
        "url-http",
        "url-https",
        "snippets",
        "wildcard",
        "everything",
        "stream-tcp",
        "stream-udp",
        "cloudflare-origin-lock",
    ];

    /// <summary>The layout a variant renders with, starting from the server's own.</summary>
    public static NginxLayout Layout(string name, NginxLayout layout) =>
        name == "ipv4-only" ? layout with { ListenIPv6 = false } : layout;

    public static NginxConfiguration Get(string name) => name switch
    {
        "empty" => NginxConfiguration.Empty,
        "http-only" => Sites(Site("plain", "plain.test")),
        "ipv4-only" => Sites(Site("v4", "v4.test")),
        "tls" => Sites(Site("tls", "tls.test", "www.tls.test") with
        {
            Certificate = _certificate,
            Hsts = new NginxHsts(IncludeSubdomains: true),
        }),
        "tls-no-redirect" => Sites(Site("open", "open.test") with
        {
            Certificate = _certificate,
            RedirectToHttps = false,
            Http2 = false,
            OcspStapling = true,
        }),
        "websocket" => Sites(Site("ws", "ws.test") with { Websocket = true }),
        "proxy-cache" => Sites(Site("cache", "cache.test") with
        {
            ProxyCache = new NginxProxyCache { TtlSeconds = 600, MaxSizeMegabytes = 256, BypassCookies = ["session"] },
        }),
        "gzip" => Sites(Site("gzip", "gzip.test") with { Gzip = true }),
        "ip-rules" => Sites(Site("guarded", "guarded.test") with
        {
            IpRules = new NginxIpRules(Allow: ["10.0.0.0/8", "2001:db8::/32"], Deny: ["10.0.0.5"]),
        }),
        "basic-auth" => Sites(Site("auth", "auth.test") with
        {
            BasicAuth = new NginxBasicAuth([new NginxBasicAuthUser(User, PasswordHash)], "Staff only"),
        }),
        "rate-limit" => Sites(Site("limited", "limited.test") with
        {
            RateLimit = new NginxRateLimit(1, NginxRatePeriod.Minute),
        }),
        "headers-and-limits" => Sites(Site("headers", "headers.test") with
        {
            SecurityHeaders = new NginxSecurityHeaders(true, NginxFrameOptions.Deny, NginxReferrerPolicy.NoReferrer),
            ResponseHeaders = [new NginxHeader("X-Served-By", "runova"), new NginxHeader("Cache-Control", "no-store")],
            ClientMaxBodySizeMegabytes = 1,
            Timeouts = new NginxTimeouts(ConnectSeconds: 5, ReadSeconds: 30, SendSeconds: 30),
        }),
        "no-security-headers" => Sites(Site("bare", "bare.test") with { SecurityHeaders = NginxSecurityHeaders.None }),
        "url-http" => Sites(Site("url", "url.test") with
        {
            Upstream = new NginxUrlUpstream($"http://{RemoteHost}:{RemoteHttpPort}/app/"),
        }),
        "url-https" => Sites(Site("secure-url", "secure-url.test") with
        {
            Upstream = new NginxUrlUpstream($"https://{RemoteHost}:{RemoteHttpsPort}", SendUpstreamHost: true),
        }),
        "snippets" => Sites(Site("snippets", "snippets.test") with
        {
            ServerSnippet = ServerSnippet,
            LocationSnippet = LocationSnippet,
        }),
        "wildcard" => Sites(Site("wild", "wild.test", "*.wild.test")),
        "everything" => Sites(Site("all", "all.test", "www.all.test") with
        {
            Certificate = _certificate,
            Hsts = new NginxHsts(NginxHsts.OneYear * 2, IncludeSubdomains: true, Preload: true),
            Websocket = true,
            ProxyCache = new NginxProxyCache { BypassCookies = ["session", "wordpress_logged_in"] },
            Gzip = true,
            IpRules = new NginxIpRules(Allow: ["127.0.0.1", "::1", "192.168.0.0/16"], Deny: []),
            BasicAuth = new NginxBasicAuth([new NginxBasicAuthUser(User, PasswordHash)]),
            RateLimit = new NginxRateLimit(100, NginxRatePeriod.Second, Burst: 50),
            ResponseHeaders = [new NginxHeader("X-Served-By", "runova")],
            ClientMaxBodySizeMegabytes = 50,
            Timeouts = new NginxTimeouts(ConnectSeconds: 10),
            LocationSnippet = "proxy_set_header X-Everything yes;\n",
        }),
        "stream-tcp" => Streams(
            new NginxStreamProxy
            {
                Id = "web-tcp",
                Protocol = NginxStreamProtocol.Tcp,
                ListenPort = TcpPort,
                Upstream = new NginxServiceUpstream("web", UpstreamPort),
            },
            new NginxStreamProxy
            {
                Id = "office-only",
                Protocol = NginxStreamProtocol.Tcp,
                ListenPort = GuardedTcpPort,
                Upstream = new NginxEndpointUpstream($"127.0.0.1:{UpstreamPort}"),
                AllowFrom = ["10.0.0.0/8"],
                ConnectTimeoutSeconds = 5,
                IdleTimeoutSeconds = 600,
            }),
        "stream-udp" => Streams(new NginxStreamProxy
        {
            Id = "echo-udp",
            Protocol = NginxStreamProtocol.Udp,
            ListenPort = UdpPort,
            Upstream = new NginxServiceUpstream("echo", UdpUpstreamPort),
            AllowFrom = ["127.0.0.1", "::1"],
            IdleTimeoutSeconds = 10,
        }),
        "cloudflare-origin-lock" => new NginxConfiguration(
            [Site("proxied", "proxied.test") with { Certificate = _certificate }],
            [],
            new NginxOriginLock(["173.245.48.0/20", "103.21.244.0/22", "2400:cb00::/32"], AuthenticatedOriginPulls: true)),
        _ => throw new ArgumentOutOfRangeException(nameof(name), name, "No such variant."),
    };

    /// <summary>All variants in one configuration.</summary>
    public static NginxConfiguration All() => new(
        [.. Names.SelectMany(name => Get(name).Sites)],
        [.. Names.SelectMany(name => Get(name).Streams)]);

    private static NginxSite Site(string id, params string[] domains) => new()
    {
        Id = id,
        Domains = domains,
        Upstream = new NginxServiceUpstream("web", UpstreamPort),
    };

    private static NginxConfiguration Sites(params NginxSite[] sites) => new(sites, []);

    private static NginxConfiguration Streams(params NginxStreamProxy[] streams) => new([], streams);
}
