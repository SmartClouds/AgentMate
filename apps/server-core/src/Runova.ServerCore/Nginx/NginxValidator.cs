using System.Collections.Frozen;

namespace Runova.ServerCore.Nginx;

/// <summary>
/// Checks a whole configuration before anything is rendered. Everything that ends up in nginx's
/// files is re-validated here, whoever built the model: user text may not contain line breaks,
/// quotes, backslashes, <c>$</c>, <c>;</c> or braces (quoting does not stop nginx reading <c>$</c>
/// as a variable or <c>\n</c> as a line break), numbers stay in sane ranges, upstreams go through
/// <see cref="UpstreamPolicy"/> and snippets through <see cref="NginxSnippet"/>. Every problem is
/// reported, each against the field it belongs to.
/// </summary>
internal static class NginxValidator
{
    public const int MaxDomainsPerSite = 100;
    public const int MaxHeaders = 32;
    public const int MaxRules = 256;
    public const int MaxUsers = 100;
    public const int MaxCookies = 16;

    /// <summary>nginx runs crypt() for every request to a protected site, so hashes may not ask for too much work.</summary>
    public const int MaxBasicAuthRounds = 50_000;

    public const int MaxBodySizeMegabytes = 102_400;
    public const int MaxTimeoutSeconds = 86_400;
    public const int MaxHstsSeconds = 63_072_000;
    public const int MaxCacheTtlSeconds = 31_536_000;
    public const int MaxCacheMegabytes = 1_048_576;
    public const int MaxRequests = 100_000;

    /// <summary>Response headers the site's own settings write; custom headers may not set them again.</summary>
    private static readonly FrozenSet<string> _managedHeaders = FrozenSet.Create(
        StringComparer.OrdinalIgnoreCase,
        "Strict-Transport-Security",
        "X-Content-Type-Options",
        "X-Frame-Options",
        "Referrer-Policy",
        "X-Cache-Status");

    public static IReadOnlyList<NginxProblem> Validate(NginxConfiguration configuration, NginxLayout layout, UpstreamPolicy upstreams)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        ArgumentNullException.ThrowIfNull(layout);
        ArgumentNullException.ThrowIfNull(upstreams);

        var problems = new List<NginxProblem>();
        var siteIds = new HashSet<string>(StringComparer.Ordinal);
        var domains = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var site in configuration.Sites)
        {
            ValidateSite(site, layout, upstreams, siteIds, domains, problems);
        }

        var streamIds = new HashSet<string>(StringComparer.Ordinal);
        var listeners = new HashSet<(NginxStreamProtocol, int)>();
        foreach (var stream in configuration.Streams)
        {
            ValidateStream(stream, upstreams, streamIds, listeners, problems);
        }

        if (configuration.OriginLock is { } originLock)
        {
            if (originLock.CloudflareNetworks.Count == 0)
            {
                problems.Add(new NginxProblem("originLock", "The origin lock needs Cloudflare's networks; fetch them again."));
            }

            ValidateNetworks(originLock.CloudflareNetworks, "originLock.cloudflareNetworks", (field, message, line) => problems.Add(new NginxProblem(field, message, line)));
        }

        return problems;
    }

    /// <summary>Lowercase letters, digits and hyphens, as used in file and zone names.</summary>
    public static bool IsId(string? id) =>
        id is { Length: > 0 and <= 63 }
        && id[0] != '-'
        && id[^1] != '-'
        && id.All(c => char.IsAsciiLetterLower(c) || char.IsAsciiDigit(c) || c == '-');

    private static void ValidateSite(
        NginxSite site,
        NginxLayout layout,
        UpstreamPolicy upstreams,
        HashSet<string> siteIds,
        Dictionary<string, string> domains,
        List<NginxProblem> problems)
    {
        var field = $"sites[{site.Id}]";
        void Add(string name, string message, int? line = null) => problems.Add(new NginxProblem($"{field}.{name}", message, line));

        if (!IsId(site.Id))
        {
            Add("id", "A site id is 1 to 63 lowercase letters, digits and hyphens, not starting or ending with a hyphen.");
        }
        else if (!siteIds.Add(site.Id))
        {
            Add("id", $"Another site already has the id {site.Id}.");
        }

        if (site.Domains.Count is 0 or > MaxDomainsPerSite)
        {
            Add("domains", $"A site needs 1 to {MaxDomainsPerSite} domains.");
        }

        for (var i = 0; i < site.Domains.Count; i++)
        {
            var domain = site.Domains[i] ?? string.Empty;
            if (NginxNames.DomainProblem(domain) is { } problem)
            {
                Add($"domains[{i}]", problem);
                continue;
            }

            var name = domain.ToLowerInvariant();
            if (domains.TryGetValue(name, out var owner))
            {
                Add($"domains[{i}]", owner == site.Id
                    ? $"{name} is listed twice."
                    : $"{name} already belongs to the site {owner}; nginx would only warn and send its visitors to one of them.");
            }
            else
            {
                domains[name] = site.Id;
            }
        }

        switch (site.Upstream)
        {
            case NginxServiceUpstream service:
                if (ServiceProblem(service, upstreams) is { } serviceProblem)
                {
                    Add("upstream", serviceProblem);
                }

                break;
            case NginxUrlUpstream url:
                if (!upstreams.TryParseUrl(url.Url, out _, out var urlProblem))
                {
                    Add("upstream", urlProblem);
                }

                break;
            default:
                Add("upstream", "A site's upstream is a stack service's port or an http:// or https:// URL.");
                break;
        }

        if (site.Certificate is { } certificate)
        {
            if (PathProblem(certificate.CertificatePath) is { } certificateProblem)
            {
                Add("certificate.certificatePath", certificateProblem);
            }

            if (PathProblem(certificate.KeyPath) is { } keyProblem)
            {
                Add("certificate.keyPath", keyProblem);
            }
        }

        if (site.Hsts is { } hsts)
        {
            if (hsts.MaxAgeSeconds is < 0 or > MaxHstsSeconds)
            {
                Add("hsts", $"HSTS max-age must be from 0 to {MaxHstsSeconds} seconds (two years).");
            }
            else if (hsts.Preload && (!hsts.IncludeSubdomains || hsts.MaxAgeSeconds < NginxHsts.OneYear))
            {
                Add("hsts", "HSTS preload needs includeSubDomains and a max-age of at least a year, or browsers will not accept it.");
            }
        }

        ValidateHeaders(site.ResponseHeaders, Add);

        if (site.IpRules is { } rules)
        {
            ValidateNetworks(rules.Deny, "ipRules.deny", Add);
            ValidateNetworks(rules.Allow, "ipRules.allow", Add);
        }

        if (site.BasicAuth is { } auth)
        {
            ValidateBasicAuth(auth, Add);
        }

        if (site.RateLimit is { } rate
            && (rate.Requests is < 1 or > MaxRequests || rate.Burst is < 0 or > MaxRequests))
        {
            Add("rateLimit", $"A rate limit needs 1 to {MaxRequests} requests and a burst from 0 to {MaxRequests}.");
        }

        if (site.ClientMaxBodySizeMegabytes is < 0 or > MaxBodySizeMegabytes)
        {
            Add("clientMaxBodySizeMegabytes", $"The body size limit must be from 0 (no limit) to {MaxBodySizeMegabytes} MB.");
        }

        if (site.Timeouts is { } timeouts)
        {
            ValidateTimeout(timeouts.ConnectSeconds, "timeouts.connectSeconds", Add);
            ValidateTimeout(timeouts.ReadSeconds, "timeouts.readSeconds", Add);
            ValidateTimeout(timeouts.SendSeconds, "timeouts.sendSeconds", Add);
        }

        if (site.ProxyCache is { } cache)
        {
            if (cache.TtlSeconds is < 1 or > MaxCacheTtlSeconds || cache.MaxSizeMegabytes is < 1 or > MaxCacheMegabytes)
            {
                Add("proxyCache", $"The cache needs a lifetime from 1 to {MaxCacheTtlSeconds} seconds and a size from 1 to {MaxCacheMegabytes} MB.");
            }

            if (cache.BypassCookies.Count > MaxCookies)
            {
                Add("proxyCache.bypassCookies", $"At most {MaxCookies} cookies can skip the cache.");
            }

            for (var i = 0; i < cache.BypassCookies.Count; i++)
            {
                var cookie = cache.BypassCookies[i] ?? string.Empty;
                if (cookie.Length is 0 or > 64 || !cookie.All(c => char.IsAsciiLetterOrDigit(c) || c == '_'))
                {
                    Add($"proxyCache.bypassCookies[{i}]", $"'{NginxNames.Show(cookie)}' cannot be read by nginx as a cookie; use 1 to 64 letters, digits and underscores.");
                }
            }
        }

        var snippetRules = new NginxSnippetRules(layout.SiteFolder(site.Id), upstreams);
        ValidateSnippet(site.ServerSnippet, NginxSnippetContext.Server, "serverSnippet", snippetRules, Add);
        ValidateSnippet(site.LocationSnippet, NginxSnippetContext.Location, "locationSnippet", snippetRules, Add);
    }

    private static void ValidateStream(
        NginxStreamProxy stream,
        UpstreamPolicy upstreams,
        HashSet<string> streamIds,
        HashSet<(NginxStreamProtocol, int)> listeners,
        List<NginxProblem> problems)
    {
        var field = $"streams[{stream.Id}]";
        void Add(string name, string message) => problems.Add(new NginxProblem($"{field}.{name}", message));

        if (!IsId(stream.Id))
        {
            Add("id", "A stream proxy id is 1 to 63 lowercase letters, digits and hyphens, not starting or ending with a hyphen.");
        }
        else if (!streamIds.Add(stream.Id))
        {
            Add("id", $"Another stream proxy already has the id {stream.Id}.");
        }

        var tcp = stream.Protocol == NginxStreamProtocol.Tcp;
        if (stream.ListenPort == 22)
        {
            Add("listenPort", "Port 22 is SSH's; nginx taking it could lock everyone out of the server.");
        }
        else if (tcp && stream.ListenPort is 80 or 443)
        {
            Add("listenPort", $"Port {stream.ListenPort} is where nginx serves the websites.");
        }
        else if (upstreams.CheckListenPort(stream.ListenPort) is { } portProblem)
        {
            Add("listenPort", portProblem);
        }
        else if (!listeners.Add((stream.Protocol, stream.ListenPort)))
        {
            Add("listenPort", $"Another stream proxy already listens on {(tcp ? "TCP" : "UDP")} port {stream.ListenPort}.");
        }

        switch (stream.Upstream)
        {
            case NginxServiceUpstream service:
                if (ServiceProblem(service, upstreams) is { } serviceProblem)
                {
                    Add("upstream", serviceProblem);
                }

                break;
            case NginxEndpointUpstream endpoint:
                if (!upstreams.TryParseEndpoint(endpoint.Endpoint, out _, out var endpointProblem))
                {
                    Add("upstream", endpointProblem);
                }

                break;
            default:
                Add("upstream", "A stream proxy's upstream is a stack service's port or a host and port like 10.0.0.5:5432.");
                break;
        }

        ValidateNetworks(stream.AllowFrom, "allowFrom", (name, message, _) => Add(name, message));
        ValidateTimeout(stream.ConnectTimeoutSeconds, "connectTimeoutSeconds", (name, message, _) => Add(name, message));
        ValidateTimeout(stream.IdleTimeoutSeconds, "idleTimeoutSeconds", (name, message, _) => Add(name, message));
    }

    private static string? ServiceProblem(NginxServiceUpstream service, UpstreamPolicy upstreams)
    {
        var name = service.Service ?? string.Empty;
        if (name.Length is 0 or > 63
            || !char.IsAsciiLetterOrDigit(name[0])
            || !name.All(c => char.IsAsciiLetterOrDigit(c) || c is '_' or '.' or '-'))
        {
            return $"'{NginxNames.Show(name)}' is not a service name.";
        }

        return upstreams.CheckPort(service.Port);
    }

    private static void ValidateHeaders(IReadOnlyList<NginxHeader> headers, Action<string, string, int?> add)
    {
        if (headers.Count > MaxHeaders)
        {
            add("responseHeaders", $"A site can add at most {MaxHeaders} headers.", null);
        }

        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i < headers.Count; i++)
        {
            var header = headers[i];
            var name = header.Name ?? string.Empty;
            if (name.Length is 0 or > 64 || !name.All(c => char.IsAsciiLetterOrDigit(c) || c == '-'))
            {
                add($"responseHeaders[{i}].name", $"'{NginxNames.Show(name)}' is not a header name; use letters, digits and hyphens.", null);
            }
            else if (_managedHeaders.Contains(name))
            {
                add($"responseHeaders[{i}].name", $"{name} is set by the site's Security settings.", null);
            }
            else if (!names.Add(name))
            {
                add($"responseHeaders[{i}].name", $"{name} is listed twice.", null);
            }

            if (TextProblem(header.Value, 1024) is { } valueProblem)
            {
                add($"responseHeaders[{i}].value", valueProblem, null);
            }
        }
    }

    private static void ValidateBasicAuth(NginxBasicAuth auth, Action<string, string, int?> add)
    {
        if (TextProblem(auth.Realm, 64) is { } realmProblem)
        {
            add("basicAuth.realm", realmProblem, null);
        }
        else if (auth.Realm.Equals("off", StringComparison.OrdinalIgnoreCase))
        {
            add("basicAuth.realm", "A realm of \"off\" would switch basic auth off: nginx reads the word itself, quoted or not.", null);
        }

        if (auth.Users.Count is 0 or > MaxUsers)
        {
            add("basicAuth.users", $"Basic auth needs 1 to {MaxUsers} users.", null);
        }

        var names = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 0; i < auth.Users.Count; i++)
        {
            var user = auth.Users[i];
            var name = user.Name ?? string.Empty;
            if (name.Length is 0 or > 64 || !name.All(c => char.IsAsciiLetterOrDigit(c) || c is '.' or '_' or '-' or '@'))
            {
                add($"basicAuth.users[{i}].name", $"'{NginxNames.Show(name)}' is not a user name; use 1 to 64 letters, digits and . _ - @.", null);
            }
            else if (!names.Add(name))
            {
                add($"basicAuth.users[{i}].name", $"{name} is listed twice.", null);
            }

            if (!Sha512Crypt.IsHash(user.PasswordHash))
            {
                add($"basicAuth.users[{i}].passwordHash", "Only SHA-512 crypt ($6$) hashes are accepted; MD5 ($apr1$) and plain text are too weak.", null);
            }
            else if (Sha512Crypt.RoundsOf(user.PasswordHash) > MaxBasicAuthRounds)
            {
                add($"basicAuth.users[{i}].passwordHash", $"nginx checks the password on every request, so a hash may use at most {MaxBasicAuthRounds} rounds.", null);
            }
        }
    }

    private static void ValidateNetworks(IReadOnlyList<string> networks, string name, Action<string, string, int?> add)
    {
        if (networks.Count > MaxRules)
        {
            add(name, $"At most {MaxRules} addresses or networks fit in one list.", null);
        }

        for (var i = 0; i < networks.Count; i++)
        {
            if (!NginxAddresses.TryParseNetwork(networks[i] ?? string.Empty, out _, out var problem))
            {
                add($"{name}[{i}]", problem, null);
            }
        }
    }

    private static void ValidateTimeout(int? seconds, string name, Action<string, string, int?> add)
    {
        if (seconds is < 1 or > MaxTimeoutSeconds)
        {
            add(name, $"A timeout must be from 1 to {MaxTimeoutSeconds} seconds.", null);
        }
    }

    private static void ValidateSnippet(
        string? snippet,
        NginxSnippetContext context,
        string name,
        NginxSnippetRules rules,
        Action<string, string, int?> add)
    {
        if (string.IsNullOrWhiteSpace(snippet))
        {
            return;
        }

        foreach (var problem in NginxSnippet.Check(snippet, context, rules))
        {
            add(name, problem.Directive is null ? problem.Reason : $"{problem.Directive}: {problem.Reason}", problem.Line);
        }
    }

    /// <summary>
    /// Text written between quotes (header values, the basic auth realm): printable ASCII without
    /// the characters that would end or change the value in nginx's syntax.
    /// </summary>
    private static string? TextProblem(string? value, int maxLength)
    {
        if (string.IsNullOrEmpty(value))
        {
            return "The value is empty.";
        }

        if (value.Length > maxLength)
        {
            return $"The value is longer than {maxLength} characters.";
        }

        foreach (var c in value)
        {
            if (c is < ' ' or > '~')
            {
                return "The value may only contain printable ASCII characters, without line breaks or control characters.";
            }

            if (c is '"' or '\'' or '\\' or '$' or ';' or '{' or '}')
            {
                return $"The value may not contain {c}: nginx would read it as configuration. Use a custom snippet for values that need it.";
            }
        }

        return null;
    }

    /// <summary>Absolute paths of plain characters, without dot segments, for files nginx reads.</summary>
    private static string? PathProblem(string? path)
    {
        var plain = path is { Length: > 1 and <= 4096 }
            && path[0] == '/'
            && path.All(c => char.IsAsciiLetterOrDigit(c) || c is '.' or '_' or '-' or '/')
            && path[1..].Split('/').All(segment => segment is not ("" or "." or ".."));
        return plain
            ? null
            : $"'{NginxNames.Show(path ?? string.Empty)}' is not an absolute path of letters, digits, '.', '_' and '-' without . or .. parts.";
    }
}
