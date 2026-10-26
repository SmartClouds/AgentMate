using Tapper;

namespace Runova.ServerCore.Contracts;

// Websites and TCP/UDP proxies in nginx (E10). Sites are saved first and go live with ApplyNginx,
// so a person can change several and apply once. Everything here is checked again on the server.

[TranspilationSource]
public enum UpstreamKind
{
    /// <summary>A service published on 127.0.0.1 at Port (a stack service, or anything local).</summary>
    ServicePort,

    /// <summary>An http:// or https:// URL in Address. Sites only.</summary>
    Url,

    /// <summary>host:port in Address. Stream proxies only.</summary>
    Endpoint,
}

/// <summary>Where a site or stream proxy sends its traffic.</summary>
/// <param name="Service">A label for the service on that port, shown in the app.</param>
/// <param name="VerifyCertificate">For an https:// URL, check the upstream's certificate.</param>
/// <param name="SendUpstreamHost">For a URL, send the upstream's own host name instead of the visitor's.</param>
[TranspilationSource]
public sealed record UpstreamTarget(
    UpstreamKind Kind,
    int? Port = null,
    string? Address = null,
    string? Service = null,
    bool VerifyCertificate = true,
    bool SendUpstreamHost = false);

[TranspilationSource]
public sealed record SiteProxyCache(int TtlSeconds = 600, int MaxSizeMegabytes = 1024, string[]? BypassCookies = null);

[TranspilationSource]
public sealed record SiteHsts(int MaxAgeSeconds = 31_536_000, bool IncludeSubdomains = false, bool Preload = false);

[TranspilationSource]
public enum SiteFrameOptions
{
    Off,
    Deny,
    SameOrigin,
}

[TranspilationSource]
public enum SiteReferrerPolicy
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

[TranspilationSource]
public sealed record SiteSecurityHeaders(
    bool NoSniff = true,
    SiteFrameOptions FrameOptions = SiteFrameOptions.SameOrigin,
    SiteReferrerPolicy ReferrerPolicy = SiteReferrerPolicy.StrictOriginWhenCrossOrigin);

[TranspilationSource]
public sealed record SiteHeader(string Name, string Value);

/// <summary>Deny rules first, then allow rules; any allow rule shuts everyone else out.</summary>
[TranspilationSource]
public sealed record SiteIpRules(string[] Allow, string[] Deny);

/// <summary>
/// A basic auth user. Password is only ever sent to the core: a new password, or null to keep
/// the one stored. The core keeps a SHA-512 crypt hash and never sends either back.
/// </summary>
[TranspilationSource]
public sealed record SiteBasicAuthUser(string Name, string? Password = null);

[TranspilationSource]
public sealed record SiteBasicAuth(SiteBasicAuthUser[] Users, string Realm = "Restricted");

[TranspilationSource]
public enum SiteRatePeriod
{
    Second,
    Minute,
}

[TranspilationSource]
public sealed record SiteRateLimit(int Requests, SiteRatePeriod Per, int Burst = 0, bool NoDelay = true);

[TranspilationSource]
public sealed record SiteTimeouts(int? ConnectSeconds = null, int? ReadSeconds = null, int? SendSeconds = null);

/// <summary>
/// What an Admin edits about a site. Custom snippets are not part of it: they are the Owner's
/// (SetSiteSnippets). Id is the site's name in files and zones: lowercase letters, digits, hyphens.
/// </summary>
/// <param name="Domains">ASCII names (xn-- for international ones); a leading *. makes a wildcard.</param>
/// <param name="ClientMaxBodySizeMegabytes">0 for no limit, null for nginx's 1 MB.</param>
[TranspilationSource]
public sealed record SiteSettings(
    string Id,
    string[] Domains,
    UpstreamTarget Upstream,
    bool Websocket = false,
    bool Gzip = false,
    SiteProxyCache? ProxyCache = null,
    bool Http2 = true,
    bool RedirectToHttps = true,
    SiteHsts? Hsts = null,
    SiteSecurityHeaders? SecurityHeaders = null,
    SiteHeader[]? ResponseHeaders = null,
    SiteIpRules? IpRules = null,
    SiteBasicAuth? BasicAuth = null,
    SiteRateLimit? RateLimit = null,
    int? ClientMaxBodySizeMegabytes = null,
    SiteTimeouts? Timeouts = null);

/// <summary>Custom directives for a site, Owner only. Null or empty removes a snippet.</summary>
[TranspilationSource]
public sealed record SiteSnippets(string SiteId, string? ServerSnippet = null, string? LocationSnippet = null);

/// <summary>
/// A site as saved. Applied is false while the saved settings differ from what nginx runs.
/// Basic auth users come back without passwords.
/// </summary>
[TranspilationSource]
public sealed record SiteInfo(
    SiteSettings Settings,
    bool Applied,
    long CreatedAtUnixMs,
    long UpdatedAtUnixMs,
    string? ServerSnippet = null,
    string? LocationSnippet = null,
    CertificateInfo? Certificate = null);

/// <summary>Why a change cannot be saved or applied, against the field (and snippet line) at fault.</summary>
[TranspilationSource]
public sealed record NginxProblemInfo(string Field, string Message, int? Line = null, string? SiteId = null);

/// <summary>Saved when Problems is empty; otherwise nothing was saved.</summary>
[TranspilationSource]
public sealed record SiteSaveResult(NginxProblemInfo[] Problems, SiteInfo? Site = null);

[TranspilationSource]
public enum StreamProxyProtocol
{
    Tcp,
    Udp,
}

/// <param name="AllowFrom">Addresses or networks that may connect; empty lets everyone in.</param>
[TranspilationSource]
public sealed record StreamProxySettings(
    string Id,
    StreamProxyProtocol Protocol,
    int ListenPort,
    UpstreamTarget Upstream,
    string[]? AllowFrom = null,
    int? ConnectTimeoutSeconds = null,
    int? IdleTimeoutSeconds = null);

[TranspilationSource]
public sealed record StreamProxyInfo(StreamProxySettings Settings, bool Applied, long UpdatedAtUnixMs);

[TranspilationSource]
public sealed record StreamProxySaveResult(NginxProblemInfo[] Problems, StreamProxyInfo? Proxy = null);

/// <summary>nginx on this server, as the core last saw it.</summary>
/// <param name="Managed">Runova's include lines are in nginx.conf and its release directory is in place.</param>
/// <param name="FromNginxOrg">Installed from nginx.org's repository rather than the distribution's.</param>
/// <param name="StreamSupported">nginx can load stream proxies (the stream module is built in or loaded).</param>
/// <param name="PendingChanges">Saved sites or proxies differ from what nginx runs.</param>
/// <param name="SeLinuxEnabled">SELinux is on, so the core manages its booleans and port labels too.</param>
[TranspilationSource]
public sealed record NginxStatus(
    bool Installed,
    bool Running,
    bool Managed,
    bool FromNginxOrg,
    bool StreamSupported,
    bool PendingChanges,
    bool SeLinuxEnabled,
    string? Version = null,
    int? CurrentRelease = null,
    long? LastAppliedAtUnixMs = null,
    string? LastAppliedBy = null);

/// <summary>
/// What an apply did. When Applied is false nginx still runs what it ran before: the new release
/// was refused by the checks, by nginx -t, or by nginx itself on reload, and Problems say where.
/// </summary>
[TranspilationSource]
public sealed record NginxApplyResult(
    bool Applied,
    NginxProblemInfo[] Problems,
    string[] Warnings,
    int? Release = null,
    string? Error = null);

[TranspilationSource]
public enum SiteLogKind
{
    Access,
    Error,
}

/// <summary>The last TailLines lines of a site's log (100 by default, at most 1000), then new ones while Follow is on.</summary>
[TranspilationSource]
public sealed record SiteLogRequest(string SiteId, SiteLogKind Kind, int? TailLines = null, bool Follow = true);

/// <summary>
/// Log lines as nginx wrote them. They come from the internet (paths, user agents): show them as
/// text only. Reset says the file was rotated or truncated, so what follows starts a new file.
/// </summary>
[TranspilationSource]
public sealed record SiteLogBatch(string[] Lines, bool Reset = false);
