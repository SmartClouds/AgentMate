using System.Globalization;
using System.Text;

namespace Runova.ServerCore.Nginx;

/// <summary>A rendered release: the files that go into one numbered release directory.</summary>
/// <param name="Directory">Where the files belong on the server; they include each other by this path.</param>
internal sealed record NginxRelease(int Number, string Directory, IReadOnlyList<NginxReleaseFile> Files);

/// <param name="Path">Relative to the release directory, with forward slashes.</param>
/// <param name="SiteId">For a snippet file, the site it belongs to, so nginx's errors can be mapped back to it.</param>
/// <param name="Snippet">For a snippet file, which of the site's snippets it holds. Its lines are the snippet's lines.</param>
internal sealed record NginxReleaseFile(string Path, string Content, string? SiteId = null, NginxSnippetContext? Snippet = null);

/// <summary>
/// Renders the typed model into the files of one release. Output is deterministic (the same model
/// gives the same bytes) and built only from validated, canonical values; nothing a user typed is
/// copied into the configuration except through the checks in <see cref="NginxValidator"/>.
/// </summary>
/// <remarks>
/// Only uniquely named zones, one map and server blocks are rendered at the http level. Anything
/// else there (gzip, ssl_*) could clash with directives already in an adopted nginx.conf, so those
/// go inside our own server blocks.
/// </remarks>
internal static class NginxRenderer
{
    public const string HttpFile = "http.conf";
    public const string StreamFile = "stream.conf";

    /// <summary>The map that asks upstreams to switch protocols for WebSocket requests.</summary>
    public static string ConnectionUpgradeVariable(NginxLayout layout) => "$" + layout.NamePrefix + "_connection_upgrade";

    private const string Header = "# Managed by Runova. Each apply writes a new release, so change this in the app instead.";

    /// <summary>Mozilla's intermediate profile without the DHE suites, which would need dhparams.</summary>
    private const string Ciphers =
        "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:"
        + "ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305";

    private const string GzipTypes =
        "text/plain text/css text/xml text/javascript application/javascript application/json "
        + "application/xml application/rss+xml application/atom+xml image/svg+xml";

    /// <summary>Validates the configuration and renders the release, or throws with every problem found.</summary>
    public static NginxRelease Render(NginxConfiguration configuration, NginxLayout layout, UpstreamPolicy upstreams, int release)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        ArgumentNullException.ThrowIfNull(layout);
        ArgumentNullException.ThrowIfNull(upstreams);
        ArgumentOutOfRangeException.ThrowIfNegative(release);

        var problems = NginxValidator.Validate(configuration, layout, upstreams);
        if (problems.Count > 0)
        {
            throw new NginxConfigurationException(problems);
        }

        var directory = layout.ReleaseDirectory(release);
        var files = new List<NginxReleaseFile> { new(HttpFile, RenderHttp(configuration, layout, directory)) };
        foreach (var site in configuration.Sites)
        {
            files.Add(new NginxReleaseFile(SitePath(site), RenderSite(site, layout, upstreams, directory, configuration.OriginLock)));

            if (site.BasicAuth is { } auth)
            {
                files.Add(new NginxReleaseFile(PasswordFilePath(site), string.Concat(auth.Users.Select(u => $"{u.Name}:{u.PasswordHash}\n"))));
            }

            if (!string.IsNullOrWhiteSpace(site.ServerSnippet))
            {
                files.Add(new NginxReleaseFile(SnippetPath(site, NginxSnippetContext.Server), SnippetText(site.ServerSnippet), site.Id, NginxSnippetContext.Server));
            }

            if (!string.IsNullOrWhiteSpace(site.LocationSnippet))
            {
                files.Add(new NginxReleaseFile(SnippetPath(site, NginxSnippetContext.Location), SnippetText(site.LocationSnippet), site.Id, NginxSnippetContext.Location));
            }
        }

        files.Add(new NginxReleaseFile(StreamFile, RenderStreams(configuration, layout, upstreams)));
        if (configuration.OriginLock is { } originLock)
        {
            files.Add(new NginxReleaseFile(NginxCloudflare.RealIpFile, RenderRealIp(originLock)));
            if (originLock.AuthenticatedOriginPulls)
            {
                files.Add(new NginxReleaseFile(NginxCloudflare.OriginPullCaFile, NginxCloudflare.OriginPullCa));
            }
        }

        return new NginxRelease(release, directory, files);
    }

    public static string SnippetPath(NginxSite site, NginxSnippetContext context)
    {
        ArgumentNullException.ThrowIfNull(site);
        return $"snippets/{site.Id}.{(context == NginxSnippetContext.Server ? "server" : "location")}.conf";
    }

    private static string SitePath(NginxSite site) => $"sites/{site.Id}.conf";

    private static string PasswordFilePath(NginxSite site) => $"auth/{site.Id}.htpasswd";

    private static string SnippetText(string snippet)
    {
        var text = NginxSnippet.Normalize(snippet);
        return text.EndsWith('\n') ? text : text + "\n";
    }

    private static string RenderHttp(NginxConfiguration configuration, NginxLayout layout, string directory)
    {
        var writer = new ConfigWriter();
        writer.Section(Header);
        writer.Section(
            "# WebSocket requests ask the upstream to switch protocols; other requests close as usual.",
            $"map $http_upgrade {ConnectionUpgradeVariable(layout)} {{",
            "    default upgrade;",
            "    \"\" close;",
            "}");

        writer.Open(
            "server",
            "# Requests for names no site claims get no answer at all, and TLS handshakes for them",
            "# are refused before any certificate is shown.");
        writer.Section(Listen(layout, "80 default_server").Concat(Listen(layout, "443 ssl default_server")).Concat(
        [
            "server_name _;",
            "ssl_reject_handshake on;",
            "return 444;",
        ]));
        writer.Close();

        writer.Section(configuration.Sites.Select(site => $"include {directory}/{SitePath(site)};"));
        return writer.ToString();
    }

    /// <summary>
    /// The visitor's address from CF-Connecting-IP, trusted only on requests from Cloudflare's
    /// networks. Included in every site's server blocks, never at the http level (see the remarks).
    /// </summary>
    private static string RenderRealIp(NginxOriginLock originLock)
    {
        var writer = new ConfigWriter();
        writer.Section(Header);
        writer.Section(
            ["# Cloudflare's networks: only requests from them may name the visitor's address.",
            .. originLock.CloudflareNetworks.Select(network => $"set_real_ip_from {Network(network)};"),
            "real_ip_header CF-Connecting-IP;"]);
        return writer.ToString();
    }

    private static string RenderSite(NginxSite site, NginxLayout layout, UpstreamPolicy upstreams, string directory, NginxOriginLock? originLock)
    {
        var domains = string.Join(' ', site.Domains.Select(d => d.ToLowerInvariant()));
        var writer = new ConfigWriter();
        writer.Section($"# Site {site.Id}: {domains}");

        var zones = new List<string>();
        if (site.ProxyCache is { } cache)
        {
            var inactive = Math.Max(cache.TtlSeconds, 3600);
            zones.Add(
                $"proxy_cache_path {layout.CacheDirectory(site.Id)} levels=1:2 keys_zone={CacheZone(site, layout)}:10m "
                + $"max_size={Number(cache.MaxSizeMegabytes)}m inactive={Number(inactive)}s use_temp_path=off;");
        }

        if (site.RateLimit is { } rate)
        {
            var unit = rate.Per == NginxRatePeriod.Second ? "s" : "m";
            zones.Add($"limit_req_zone $binary_remote_addr zone={RateZone(site, layout)}:10m rate={Number(rate.Requests)}r/{unit};");
        }

        writer.Section(zones);

        var tls = site.Certificate is not null;
        var redirect = tls && site.RedirectToHttps;

        writer.Open("server", redirect ? ["# Plain HTTP answers ACME challenges and sends everything else to HTTPS."] : []);
        writer.Section(Listen(layout, "80").Concat(
        [
            $"server_name {domains};",
            "server_tokens off;",
        ]).Concat(redirect ? [] : [$"root {layout.SiteFolder(site.Id)};"]).Concat(Logs(site, layout)));
        if (originLock is not null)
        {
            writer.Section($"include {directory}/{NginxCloudflare.RealIpFile};");
        }

        WriteAcmeLocation(writer, layout);
        if (redirect)
        {
            writer.Open("location /");
            writer.Section("return 301 https://$host$request_uri;");
            writer.Close();
        }
        else
        {
            WriteServerBody(writer, site, layout, upstreams, directory, overTls: false);
        }

        writer.Close();

        if (site.Certificate is { } certificate)
        {
            writer.Open("server");
            writer.Section(Listen(layout, "443 ssl").Concat(site.Http2 ? ["http2 on;"] : []).Concat(
            [
                $"server_name {domains};",
                "server_tokens off;",
                $"root {layout.SiteFolder(site.Id)};",
            ]).Concat(Logs(site, layout)));
            writer.Section(
            [
                $"ssl_certificate {certificate.CertificatePath};",
                $"ssl_certificate_key {certificate.KeyPath};",
                "ssl_protocols TLSv1.2 TLSv1.3;",
                $"ssl_ciphers {Ciphers};",
                $"ssl_session_cache shared:{layout.NamePrefix}_tls:10m;",
                "ssl_session_timeout 1d;",
                "ssl_session_tickets off;",
                .. site.OcspStapling ? (string[])["ssl_stapling on;", "ssl_stapling_verify on;"] : ["ssl_stapling off;"],
            ]);
            if (originLock is not null)
            {
                writer.Section($"include {directory}/{NginxCloudflare.RealIpFile};");
            }

            if (originLock is { AuthenticatedOriginPulls: true })
            {
                writer.Section(
                    "# Authenticated Origin Pulls: HTTPS only for Cloudflare's client certificate.",
                    $"ssl_client_certificate {directory}/{NginxCloudflare.OriginPullCaFile};",
                    "ssl_verify_client on;");
            }

            WriteServerBody(writer, site, layout, upstreams, directory, overTls: true);
            writer.Close();
        }

        return writer.ToString();
    }

    /// <summary>
    /// Let's Encrypt's HTTP-01 challenge files, served from the shared webroot. IP rules and basic
    /// auth are lifted here so a locked-down site can still renew its certificate.
    /// </summary>
    private static void WriteAcmeLocation(ConfigWriter writer, NginxLayout layout)
    {
        writer.Open("location ^~ /.well-known/acme-challenge/");
        writer.Section(
            $"root {layout.AcmeWebroot};",
            "default_type text/plain;",
            "try_files $uri =404;",
            "allow all;",
            "auth_basic off;");
        writer.Close();
    }

    private static void WriteServerBody(ConfigWriter writer, NginxSite site, NginxLayout layout, UpstreamPolicy upstreams, string directory, bool overTls)
    {
        if (site.ClientMaxBodySizeMegabytes is { } bodySize)
        {
            writer.Section($"client_max_body_size {Number(bodySize)}{(bodySize == 0 ? string.Empty : "m")};");
        }

        if (site.IpRules is { } rules)
        {
            writer.Section(
                rules.Deny.Select(network => $"deny {Network(network)};")
                    .Concat(rules.Allow.Select(network => $"allow {Network(network)};"))
                    .Concat(rules.Allow.Count > 0 ? ["deny all;"] : []));
        }

        if (site.BasicAuth is { } auth)
        {
            writer.Section(
                $"auth_basic {Quote(auth.Realm)};",
                $"auth_basic_user_file {directory}/{PasswordFilePath(site)};");
        }

        if (site.RateLimit is { } rate)
        {
            var burst = rate.Burst > 0 ? $" burst={Number(rate.Burst)}{(rate.NoDelay ? " nodelay" : string.Empty)}" : string.Empty;
            writer.Section($"limit_req zone={RateZone(site, layout)}{burst};", "limit_req_status 429;");
        }

        if (site.Gzip)
        {
            writer.Section(
                "gzip on;",
                "gzip_vary on;",
                "gzip_proxied any;",
                "gzip_comp_level 5;",
                "gzip_min_length 256;",
                $"gzip_types {GzipTypes};");
        }

        var headers = ResponseHeaders(site, overTls);
        writer.Section(headers);

        if (!string.IsNullOrWhiteSpace(site.ServerSnippet))
        {
            writer.Section($"include {directory}/{SnippetPath(site, NginxSnippetContext.Server)};");
        }

        writer.Open("location /");
        writer.Section(ProxyLines(site, layout, upstreams));

        if (site.ProxyCache is { } cache)
        {
            List<string> skip = ["$http_authorization", .. site.Websocket ? ["$http_upgrade"] : Array.Empty<string>()];
            skip.AddRange(cache.BypassCookies.Select(cookie => "$cookie_" + cookie));
            var bypass = string.Join(' ', skip);
            writer.Section(
                $"proxy_cache {CacheZone(site, layout)};",
                "proxy_cache_key $scheme$host$request_uri;",
                $"proxy_cache_valid 200 301 302 {Number(cache.TtlSeconds)}s;",
                "proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;",
                "proxy_cache_lock on;",
                $"proxy_cache_bypass {bypass};",
                $"proxy_no_cache {bypass};",
                "add_header X-Cache-Status $upstream_cache_status always;");
        }

        // A location with an add_header of its own (the cache status, or one in the location
        // snippet) inherits none of the server's, so they are repeated there.
        if (headers.Count > 0 && (site.ProxyCache is not null || !string.IsNullOrWhiteSpace(site.LocationSnippet)))
        {
            writer.Section(["# nginx drops the server's add_header lines in a location that has its own, so they repeat here.", .. headers]);
        }

        if (!string.IsNullOrWhiteSpace(site.LocationSnippet))
        {
            writer.Section($"include {directory}/{SnippetPath(site, NginxSnippetContext.Location)};");
        }

        writer.Close();
    }

    private static List<string> ResponseHeaders(NginxSite site, bool overTls)
    {
        var headers = new List<string>();
        if (overTls && site.Hsts is { } hsts)
        {
            var value = "max-age=" + Number(hsts.MaxAgeSeconds)
                + (hsts.IncludeSubdomains ? "; includeSubDomains" : string.Empty)
                + (hsts.Preload ? "; preload" : string.Empty);
            headers.Add($"add_header Strict-Transport-Security {Quote(value)} always;");
        }

        var security = site.SecurityHeaders;
        if (security.NoSniff)
        {
            headers.Add("add_header X-Content-Type-Options \"nosniff\" always;");
        }

        if (security.FrameOptions != NginxFrameOptions.Off)
        {
            headers.Add($"add_header X-Frame-Options {Quote(security.FrameOptions == NginxFrameOptions.Deny ? "DENY" : "SAMEORIGIN")} always;");
        }

        if (ReferrerPolicy(security.ReferrerPolicy) is { } referrer)
        {
            headers.Add($"add_header Referrer-Policy {Quote(referrer)} always;");
        }

        headers.AddRange(site.ResponseHeaders.Select(header => $"add_header {header.Name} {Quote(header.Value)} always;"));
        return headers;
    }

    private static List<string> ProxyLines(NginxSite site, NginxLayout layout, UpstreamPolicy upstreams)
    {
        var lines = new List<string>();
        UpstreamUrl? url = null;
        switch (site.Upstream)
        {
            case NginxServiceUpstream service:
                lines.Add($"proxy_pass http://127.0.0.1:{Number(service.Port)};");
                break;
            case NginxUrlUpstream given:
                if (!upstreams.TryParseUrl(given.Url, out url, out var problem))
                {
                    throw new InvalidOperationException("An upstream passed validation but not parsing: " + problem);
                }

                lines.Add($"proxy_pass {url.ToNginx()};");
                break;
            default:
                throw new InvalidOperationException("A site upstream of an unknown kind passed validation.");
        }

        var sendUpstreamHost = site.Upstream is NginxUrlUpstream { SendUpstreamHost: true };
        lines.AddRange(
        [
            "proxy_http_version 1.1;",
            sendUpstreamHost ? "proxy_set_header Host $proxy_host;" : "proxy_set_header Host $host;",
            "proxy_set_header X-Real-IP $remote_addr;",
            "# The visitor's own address replaces any X-Forwarded-For they sent, so it cannot be forged.",
            "proxy_set_header X-Forwarded-For $remote_addr;",
            "proxy_set_header X-Forwarded-Proto $scheme;",
            "proxy_set_header X-Forwarded-Host $host;",
            "proxy_set_header X-Forwarded-Port $server_port;",
        ]);

        if (site.Websocket)
        {
            lines.Add("proxy_set_header Upgrade $http_upgrade;");
            lines.Add($"proxy_set_header Connection {ConnectionUpgradeVariable(layout)};");
        }

        if (url is { IsHttps: true })
        {
            var verify = site.Upstream is NginxUrlUpstream { VerifyCertificate: true };
            lines.Add("proxy_ssl_server_name on;");
            lines.Add($"proxy_ssl_name {url.Host};");
            lines.Add("proxy_ssl_protocols TLSv1.2 TLSv1.3;");
            if (verify)
            {
                lines.Add("proxy_ssl_verify on;");
                lines.Add("proxy_ssl_verify_depth 3;");
                lines.Add($"proxy_ssl_trusted_certificate {layout.TrustedCertificates};");
            }
            else
            {
                lines.Add("proxy_ssl_verify off;");
            }
        }

        // WebSocket connections sit idle between messages; nginx's 60 seconds would cut them off.
        var timeouts = site.Timeouts ?? new NginxTimeouts();
        var idle = site.Websocket ? 3600 : (int?)null;
        if (timeouts.ConnectSeconds is { } connect)
        {
            lines.Add($"proxy_connect_timeout {Number(connect)}s;");
        }

        if ((timeouts.ReadSeconds ?? idle) is { } read)
        {
            lines.Add($"proxy_read_timeout {Number(read)}s;");
        }

        if ((timeouts.SendSeconds ?? idle) is { } send)
        {
            lines.Add($"proxy_send_timeout {Number(send)}s;");
        }

        return lines;
    }

    private static string RenderStreams(NginxConfiguration configuration, NginxLayout layout, UpstreamPolicy upstreams)
    {
        var writer = new ConfigWriter();
        writer.Section(Header, "# TCP and UDP ports passed straight through to a service; nginx.conf includes this in its stream block.");
        foreach (var stream in configuration.Streams)
        {
            var udp = stream.Protocol == NginxStreamProtocol.Udp;
            var target = stream.Upstream switch
            {
                NginxServiceUpstream service => $"127.0.0.1:{Number(service.Port)}",
                NginxEndpointUpstream endpoint when upstreams.TryParseEndpoint(endpoint.Endpoint, out var parsed, out _) => parsed.ToNginx(),
                _ => throw new InvalidOperationException("A stream upstream passed validation but not parsing."),
            };

            writer.Open("server", $"# Stream proxy {stream.Id}: {(udp ? "UDP" : "TCP")} port {Number(stream.ListenPort)}");
            var suffix = udp ? " udp" : string.Empty;
            writer.Section(Listen(layout, Number(stream.ListenPort) + suffix).Concat([$"proxy_pass {target};"])
                .Concat(stream.ConnectTimeoutSeconds is { } connect ? [$"proxy_connect_timeout {Number(connect)}s;"] : [])
                .Concat(stream.IdleTimeoutSeconds is { } idle ? [$"proxy_timeout {Number(idle)}s;"] : []));
            if (stream.AllowFrom.Count > 0)
            {
                writer.Section(stream.AllowFrom.Select(network => $"allow {Network(network)};").Concat(["deny all;"]));
            }

            writer.Close();
        }

        return writer.ToString();
    }

    /// <summary>Each site logs to files of its own, which the app reads through the core (E10 T8).</summary>
    private static string[] Logs(NginxSite site, NginxLayout layout) =>
        [$"access_log {layout.AccessLog(site.Id)};", $"error_log {layout.ErrorLog(site.Id)};"];

    private static IEnumerable<string> Listen(NginxLayout layout, string what) =>
        layout.ListenIPv6 ? [$"listen {what};", $"listen [::]:{what};"] : [$"listen {what};"];

    private static string CacheZone(NginxSite site, NginxLayout layout) => layout.NamePrefix + "_cache_" + site.Id;

    private static string RateZone(NginxSite site, NginxLayout layout) => layout.NamePrefix + "_rate_" + site.Id;

    private static string Network(string network) =>
        NginxAddresses.TryParseNetwork(network, out var canonical, out var problem)
            ? canonical
            : throw new InvalidOperationException("A network passed validation but not parsing: " + problem);

    /// <summary>Double quotes around a value the validator has already cleared of quotes, backslashes and $.</summary>
    private static string Quote(string value) => "\"" + value + "\"";

    private static string Number(int value) => value.ToString(CultureInfo.InvariantCulture);

    private static string? ReferrerPolicy(NginxReferrerPolicy policy) => policy switch
    {
        NginxReferrerPolicy.NoReferrer => "no-referrer",
        NginxReferrerPolicy.NoReferrerWhenDowngrade => "no-referrer-when-downgrade",
        NginxReferrerPolicy.Origin => "origin",
        NginxReferrerPolicy.OriginWhenCrossOrigin => "origin-when-cross-origin",
        NginxReferrerPolicy.SameOrigin => "same-origin",
        NginxReferrerPolicy.StrictOrigin => "strict-origin",
        NginxReferrerPolicy.StrictOriginWhenCrossOrigin => "strict-origin-when-cross-origin",
        _ => null,
    };

    /// <summary>Writes indented lines, with one blank line between sections and none doubled.</summary>
    private sealed class ConfigWriter
    {
        private readonly StringBuilder _text = new();
        private int _depth;
        private bool _separate;

        public void Section(params IEnumerable<string> lines)
        {
            var first = true;
            foreach (var line in lines)
            {
                if (first && _separate)
                {
                    _text.Append('\n');
                }

                first = false;
                Line(line);
            }

            if (!first)
            {
                _separate = true;
            }
        }

        /// <summary>Starts a block, with comment lines kept directly above it.</summary>
        public void Open(string header, params IEnumerable<string> comments)
        {
            if (_separate)
            {
                _text.Append('\n');
            }

            foreach (var comment in comments)
            {
                Line(comment);
            }

            Line(header + " {");
            _depth++;
            _separate = false;
        }

        public void Close()
        {
            _depth--;
            Line("}");
            _separate = true;
        }

        public override string ToString() => _text.ToString();

        private void Line(string line) => _text.Append(' ', _depth * 4).Append(line).Append('\n');
    }
}
