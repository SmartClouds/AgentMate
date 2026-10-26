namespace Runova.ServerCore.Nginx;

/// <summary>Everything Runova manages in nginx on one server: its websites and its TCP and UDP proxies.</summary>
/// <param name="OriginLock">Set while the Cloudflare origin lock is on (E14): every site takes the visitor's address from Cloudflare.</param>
internal sealed record NginxConfiguration(IReadOnlyList<NginxSite> Sites, IReadOnlyList<NginxStreamProxy> Streams, NginxOriginLock? OriginLock = null)
{
    public static NginxConfiguration Empty { get; } = new([], []);
}

/// <summary>
/// One website: the domains it answers for, where requests go, and the options around them. Every
/// value is checked again before rendering (<see cref="NginxValidator"/>), whoever built the model.
/// </summary>
internal sealed record NginxSite
{
    /// <summary>Names the site's files and nginx zones: lowercase letters, digits and hyphens.</summary>
    public required string Id { get; init; }

    /// <summary>ASCII domain names (xn-- for international ones); a leading <c>*.</c> makes a wildcard.</summary>
    public required IReadOnlyList<string> Domains { get; init; }

    public required NginxUpstream Upstream { get; init; }

    /// <summary>Null until a certificate exists; the site is served over plain HTTP until then.</summary>
    public NginxCertificate? Certificate { get; init; }

    /// <summary>With a certificate, send plain HTTP visitors to HTTPS (ACME challenges stay on HTTP).</summary>
    public bool RedirectToHttps { get; init; } = true;

    public bool Http2 { get; init; } = true;

    /// <summary>Off by default: Let's Encrypt certificates carry no OCSP address any more.</summary>
    public bool OcspStapling { get; init; }

    public bool Websocket { get; init; }

    public NginxProxyCache? ProxyCache { get; init; }

    public bool Gzip { get; init; }

    public NginxSecurityHeaders SecurityHeaders { get; init; } = NginxSecurityHeaders.Recommended;

    /// <summary>Only rendered once the site has a certificate, since browsers ignore it over plain HTTP.</summary>
    public NginxHsts? Hsts { get; init; }

    public IReadOnlyList<NginxHeader> ResponseHeaders { get; init; } = [];

    public NginxIpRules? IpRules { get; init; }

    public NginxBasicAuth? BasicAuth { get; init; }

    public NginxRateLimit? RateLimit { get; init; }

    /// <summary>The largest request body in megabytes; 0 means no limit, null keeps nginx's 1 MB.</summary>
    public int? ClientMaxBodySizeMegabytes { get; init; }

    public NginxTimeouts? Timeouts { get; init; }

    /// <summary>Custom directives for the server block, checked by <see cref="NginxSnippet"/>.</summary>
    public string? ServerSnippet { get; init; }

    /// <summary>Custom directives for the location that proxies to the upstream, checked by <see cref="NginxSnippet"/>.</summary>
    public string? LocationSnippet { get; init; }
}

/// <summary>Where a site or stream proxy sends its traffic.</summary>
internal abstract record NginxUpstream;

/// <summary>A stack service published on 127.0.0.1 at this port (the service port picker).</summary>
internal sealed record NginxServiceUpstream(string Service, int Port) : NginxUpstream;

/// <summary>A site's upstream given as an http:// or https:// URL.</summary>
/// <param name="VerifyCertificate">For https://, check the upstream's certificate against the system's trusted CAs.</param>
/// <param name="SendUpstreamHost">Send the upstream's own host name as Host instead of the visitor's.</param>
internal sealed record NginxUrlUpstream(string Url, bool VerifyCertificate = true, bool SendUpstreamHost = false) : NginxUpstream;

/// <summary>A stream proxy's upstream given as host:port.</summary>
internal sealed record NginxEndpointUpstream(string Endpoint) : NginxUpstream;

/// <summary>PEM files nginx reads (as root) when it loads the configuration.</summary>
internal sealed record NginxCertificate(string CertificatePath, string KeyPath);

internal sealed record NginxProxyCache
{
    public int TtlSeconds { get; init; } = 600;

    public int MaxSizeMegabytes { get; init; } = 1024;

    /// <summary>Requests carrying any of these cookies skip the cache (session cookies, typically).</summary>
    public IReadOnlyList<string> BypassCookies { get; init; } = [];
}

internal enum NginxFrameOptions
{
    Off,
    Deny,
    SameOrigin,
}

internal enum NginxReferrerPolicy
{
    Off,
    NoReferrer,
    NoReferrerWhenDowngrade,
    Origin,
    OriginWhenCrossOrigin,
    SameOrigin,
    StrictOrigin,
    StrictOriginWhenCrossOrigin,
}

internal sealed record NginxSecurityHeaders(bool NoSniff, NginxFrameOptions FrameOptions, NginxReferrerPolicy ReferrerPolicy)
{
    public static NginxSecurityHeaders Recommended { get; } =
        new(true, NginxFrameOptions.SameOrigin, NginxReferrerPolicy.StrictOriginWhenCrossOrigin);

    public static NginxSecurityHeaders None { get; } = new(false, NginxFrameOptions.Off, NginxReferrerPolicy.Off);
}

internal sealed record NginxHsts(int MaxAgeSeconds = NginxHsts.OneYear, bool IncludeSubdomains = false, bool Preload = false)
{
    public const int OneYear = 31_536_000;
}

internal sealed record NginxHeader(string Name, string Value);

/// <summary>Deny rules come first, then allow rules; any allow rule means everyone else is denied.</summary>
internal sealed record NginxIpRules(IReadOnlyList<string> Allow, IReadOnlyList<string> Deny);

internal sealed record NginxBasicAuth(IReadOnlyList<NginxBasicAuthUser> Users, string Realm = "Restricted");

/// <param name="PasswordHash">A SHA-512 crypt hash (<see cref="Sha512Crypt"/>); never a password.</param>
internal sealed record NginxBasicAuthUser(string Name, string PasswordHash);

internal enum NginxRatePeriod
{
    Second,
    Minute,
}

/// <summary>Requests per visitor address; <paramref name="Burst"/> more may queue (or pass at once with <paramref name="NoDelay"/>).</summary>
internal sealed record NginxRateLimit(int Requests, NginxRatePeriod Per, int Burst = 0, bool NoDelay = true);

internal sealed record NginxTimeouts(int? ConnectSeconds = null, int? ReadSeconds = null, int? SendSeconds = null);

internal enum NginxStreamProtocol
{
    Tcp,
    Udp,
}

/// <summary>A public TCP or UDP port passed straight through to a service.</summary>
internal sealed record NginxStreamProxy
{
    public required string Id { get; init; }

    public required NginxStreamProtocol Protocol { get; init; }

    public required int ListenPort { get; init; }

    /// <summary>A <see cref="NginxServiceUpstream"/> or an <see cref="NginxEndpointUpstream"/>.</summary>
    public required NginxUpstream Upstream { get; init; }

    /// <summary>Addresses or networks that may connect; empty lets everyone in.</summary>
    public IReadOnlyList<string> AllowFrom { get; init; } = [];

    public int? ConnectTimeoutSeconds { get; init; }

    /// <summary>How long a connection (or a UDP session) may sit idle.</summary>
    public int? IdleTimeoutSeconds { get; init; }
}

/// <summary>Why a configuration cannot be rendered, pointing at the field (and snippet line) at fault.</summary>
internal sealed record NginxProblem(string Field, string Message, int? Line = null)
{
    public override string ToString() => Line is { } line ? $"{Field}, line {line}: {Message}" : $"{Field}: {Message}";
}

internal sealed class NginxConfigurationException(IReadOnlyList<NginxProblem> problems)
    : Exception("The nginx configuration was not rendered: " + string.Join(" ", problems))
{
    public IReadOnlyList<NginxProblem> Problems { get; } = problems;
}

/// <summary>
/// Sites behind Cloudflare (E14): requests from Cloudflare's networks carry the visitor's address
/// in CF-Connecting-IP, which nginx then uses as the client address (for logs, IP rules and rate
/// limits); a request from anywhere else keeps its own. With Authenticated Origin Pulls, HTTPS
/// only completes for a client presenting Cloudflare's origin pull certificate.
/// </summary>
internal sealed record NginxOriginLock(IReadOnlyList<string> CloudflareNetworks, bool AuthenticatedOriginPulls = false);
