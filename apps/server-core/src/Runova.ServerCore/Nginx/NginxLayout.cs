using System.Globalization;
using Runova.ServerCore.Compatibility;

namespace Runova.ServerCore.Nginx;

/// <summary>
/// Where Runova's nginx files live on a server. The configuration nginx loads is one directory we
/// own, <c>/etc/nginx/runova/current</c>, a symlink to a numbered release under
/// <c>releases/</c>. nginx.conf includes it in two places, since nginx allows only one http block
/// and one stream block: <see cref="HttpInclude"/> inside <c>http { }</c> and
/// <see cref="StreamInclude"/> inside a <c>stream { }</c> block at the top level.
/// </summary>
internal sealed record NginxLayout
{
    public const string DebianTrustedCertificates = "/etc/ssl/certs/ca-certificates.crt";
    public const string RhelTrustedCertificates = "/etc/pki/tls/certs/ca-bundle.crt";

    public static NginxLayout Debian { get; } = new();

    public static NginxLayout Rhel { get; } = new() { TrustedCertificates = RhelTrustedCertificates };

    private static readonly Lazy<bool> _legacyNamesHere = new(() =>
        OperatingSystem.IsLinux() && Directory.Exists(LegacyNames.NginxConfigRoot) && !Directory.Exists(Debian.ConfigRoot));

    /// <summary>
    /// Whether nginx on this server was set up before the rename: its folder under the old name is
    /// there and the new one is not. Such a server keeps every name it has (folders, logs, zones),
    /// so nothing nginx serves moves; a new setup uses the new names.
    /// </summary>
    public static bool LegacyNamesHere => _legacyNamesHere.Value;

    /// <summary>The prefix of what nginx itself names: log files, cache folders, zones and the upgrade map.</summary>
    public string NamePrefix { get; init; } = "runova";

    /// <summary>This layout with the folders and names of an nginx set up before the rename.</summary>
    public NginxLayout WithLegacyNames() => this with
    {
        ConfigRoot = LegacyNames.NginxConfigRoot,
        AcmeWebroot = LegacyNames.NginxWebRoot + "/acme",
        SitesRoot = LegacyNames.NginxWebRoot + "/sites",
        NamePrefix = LegacyNames.NginxNamePrefix,
    };

    public string ConfigRoot { get; init; } = "/etc/nginx/runova";

    /// <summary>
    /// Challenge files for ACME HTTP-01 go to <c>{AcmeWebroot}/.well-known/acme-challenge/</c>.
    /// Outside the core's own state folder, which nginx's workers cannot read.
    /// </summary>
    public string AcmeWebroot { get; init; } = "/var/www/runova/acme";

    /// <summary>Each site's folder is <c>{SitesRoot}/{id}</c>, the only place snippets may serve files from.</summary>
    public string SitesRoot { get; init; } = "/var/www/runova/sites";

    /// <summary>
    /// Proxy caches go directly in here, one folder per site, because nginx creates only the last
    /// folder of a cache path. The nginx.org packages create /var/cache/nginx.
    /// </summary>
    public string CacheRoot { get; init; } = "/var/cache/nginx";

    /// <summary>The system CA bundle https:// upstreams are verified against.</summary>
    public string TrustedCertificates { get; init; } = DebianTrustedCertificates;

    /// <summary>Also listen on IPv6. Off for hosts without IPv6, where nginx would fail to bind [::].</summary>
    public bool ListenIPv6 { get; init; } = true;

    public string CurrentLink => ConfigRoot + "/current";

    public string ReleasesDirectory => ConfigRoot + "/releases";

    /// <summary>The line inside nginx.conf's http block that loads the sites.</summary>
    public string HttpInclude => $"include {CurrentLink}/{NginxRenderer.HttpFile};";

    /// <summary>The line inside a top-level stream block that loads the TCP and UDP proxies.</summary>
    public string StreamInclude => $"include {CurrentLink}/{NginxRenderer.StreamFile};";

    public string ReleaseDirectory(int release) =>
        ReleasesDirectory + "/" + release.ToString(CultureInfo.InvariantCulture);

    public string SiteFolder(string siteId) => SitesRoot + "/" + siteId;

    public string CacheDirectory(string siteId) => $"{CacheRoot}/{NamePrefix}-{siteId}";

    /// <summary>
    /// Where nginx writes logs. Each site's go directly in here, named &lt;prefix&gt;-&lt;id&gt;, so the
    /// logrotate rule nginx's package ships (/var/log/nginx/*.log) rotates them too.
    /// </summary>
    public string LogDirectory { get; init; } = "/var/log/nginx";

    /// <summary>nginx's own error log, which a failed reload writes to.</summary>
    public string ErrorLogFile => LogDirectory + "/error.log";

    public string AccessLog(string siteId) => $"{LogDirectory}/{NamePrefix}-{siteId}.access.log";

    public string ErrorLog(string siteId) => $"{LogDirectory}/{NamePrefix}-{siteId}.error.log";

    /// <summary>Certificates for nginx, one root-only folder per site; the core's database is the source.</summary>
    public string CertificatesDirectory => ConfigRoot + "/certs";

    public string CertificateFile(string siteId) => $"{CertificatesDirectory}/{siteId}/fullchain.pem";

    public string KeyFile(string siteId) => $"{CertificatesDirectory}/{siteId}/privkey.pem";

    /// <summary>Written while an apply is under way, so a core that stopped halfway can finish or undo it.</summary>
    public string ApplyMarker => ConfigRoot + "/apply.json";

    /// <summary>ACME HTTP-01 answers, served by every site's challenge location.</summary>
    public string AcmeChallengeDirectory => AcmeWebroot + "/.well-known/acme-challenge";
}
