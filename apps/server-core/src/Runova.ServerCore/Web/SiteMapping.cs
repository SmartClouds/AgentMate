using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Nginx;

namespace Runova.ServerCore.Web;

/// <summary>
/// Between what the app sends and the typed nginx model. Nothing here decides what is allowed:
/// the model goes through <see cref="NginxValidator"/> whoever built it. This only turns the wire
/// shape into the model, hashes new basic auth passwords, and says which wire fields are missing.
/// </summary>
internal static class SiteMapping
{
    /// <summary>Snippets arrive inside a 64 KB message; this leaves room for everything else in it.</summary>
    public const int MaxSnippetLength = 16 * 1024;

    public static string Serialize<T>(T value) => JsonSerializer.Serialize(value, CoreJson.Options);

    public static T Deserialize<T>(string json) =>
        JsonSerializer.Deserialize<T>(json, CoreJson.Options) ?? throw new InvalidDataException("A stored site could not be read.");

    /// <summary>The settings as stored and shown: no passwords, domains in lowercase.</summary>
    public static SiteSettings Normalize(SiteSettings settings) => settings with
    {
        Domains = [.. (settings.Domains ?? []).Select(domain => (domain ?? string.Empty).Trim().ToLowerInvariant())],
        BasicAuth = settings.BasicAuth is { } auth
            ? auth with { Users = [.. (auth.Users ?? []).Select(user => new SiteBasicAuthUser(user?.Name ?? string.Empty))] }
            : null,
    };

    /// <summary>
    /// The hashes to store: a new password is hashed, a missing one keeps the hash stored for that
    /// user. A user with neither is a problem.
    /// </summary>
    public static Dictionary<string, string> HashPasswords(SiteSettings settings, IReadOnlyDictionary<string, string> stored, List<NginxProblem> problems)
    {
        var hashes = new Dictionary<string, string>(StringComparer.Ordinal);
        var users = settings.BasicAuth?.Users ?? [];
        for (var i = 0; i < users.Length; i++)
        {
            var name = users[i]?.Name ?? string.Empty;
            var password = users[i]?.Password;
            if (!string.IsNullOrEmpty(password))
            {
                if (password.Length is < 8 or > 256)
                {
                    problems.Add(new NginxProblem($"sites[{settings.Id}].basicAuth.users[{i}].password", "A basic auth password is 8 to 256 characters."));
                    continue;
                }

                hashes[name] = Sha512Crypt.Hash(password);
            }
            else if (stored.TryGetValue(name, out var hash))
            {
                hashes[name] = hash;
            }
            else
            {
                problems.Add(new NginxProblem($"sites[{settings.Id}].basicAuth.users[{i}].password", $"{NginxNames.Show(name)} needs a password."));
            }
        }

        return hashes;
    }

    public static NginxSite ToModel(Site row, NginxCertificate? certificate)
    {
        ArgumentNullException.ThrowIfNull(row);
        var settings = Deserialize<SiteSettings>(row.Settings);
        var hashes = row.BasicAuthHashes is null ? [] : Deserialize<Dictionary<string, string>>(row.BasicAuthHashes);
        return ToModel(settings, hashes, row.ServerSnippet, row.LocationSnippet, certificate);
    }

    public static NginxSite ToModel(
        SiteSettings settings,
        IReadOnlyDictionary<string, string> hashes,
        string? serverSnippet,
        string? locationSnippet,
        NginxCertificate? certificate)
    {
        ArgumentNullException.ThrowIfNull(settings);
        var security = settings.SecurityHeaders ?? new SiteSecurityHeaders();
        return new NginxSite
        {
            Id = settings.Id ?? string.Empty,
            Domains = settings.Domains ?? [],
            Upstream = SiteUpstream(settings.Upstream),
            Certificate = certificate,
            RedirectToHttps = settings.RedirectToHttps,
            Http2 = settings.Http2,
            Websocket = settings.Websocket,
            ProxyCache = settings.ProxyCache is { } cache
                ? new NginxProxyCache { TtlSeconds = cache.TtlSeconds, MaxSizeMegabytes = cache.MaxSizeMegabytes, BypassCookies = cache.BypassCookies ?? [] }
                : null,
            Gzip = settings.Gzip,
            SecurityHeaders = new NginxSecurityHeaders(
                security.NoSniff,
                Enum.Parse<NginxFrameOptions>(security.FrameOptions.ToString()),
                Enum.Parse<NginxReferrerPolicy>(security.ReferrerPolicy.ToString())),
            Hsts = settings.Hsts is { } hsts ? new NginxHsts(hsts.MaxAgeSeconds, hsts.IncludeSubdomains, hsts.Preload) : null,
            ResponseHeaders = [.. (settings.ResponseHeaders ?? []).Select(header => new NginxHeader(header?.Name ?? string.Empty, header?.Value ?? string.Empty))],
            IpRules = settings.IpRules is { } rules ? new NginxIpRules(rules.Allow ?? [], rules.Deny ?? []) : null,
            BasicAuth = settings.BasicAuth is { } auth
                ? new NginxBasicAuth(
                    [.. (auth.Users ?? []).Select(user => new NginxBasicAuthUser(user?.Name ?? string.Empty, hashes.GetValueOrDefault(user?.Name ?? string.Empty, string.Empty)))],
                    auth.Realm ?? string.Empty)
                : null,
            RateLimit = settings.RateLimit is { } rate
                ? new NginxRateLimit(rate.Requests, rate.Per == SiteRatePeriod.Second ? NginxRatePeriod.Second : NginxRatePeriod.Minute, rate.Burst, rate.NoDelay)
                : null,
            ClientMaxBodySizeMegabytes = settings.ClientMaxBodySizeMegabytes,
            Timeouts = settings.Timeouts is { } timeouts ? new NginxTimeouts(timeouts.ConnectSeconds, timeouts.ReadSeconds, timeouts.SendSeconds) : null,
            ServerSnippet = serverSnippet,
            LocationSnippet = locationSnippet,
        };
    }

    public static NginxStreamProxy ToModel(StreamProxySettings settings)
    {
        ArgumentNullException.ThrowIfNull(settings);
        return new NginxStreamProxy
        {
            Id = settings.Id ?? string.Empty,
            Protocol = settings.Protocol == StreamProxyProtocol.Udp ? NginxStreamProtocol.Udp : NginxStreamProtocol.Tcp,
            ListenPort = settings.ListenPort,
            Upstream = settings.Upstream switch
            {
                { Kind: UpstreamKind.ServicePort } target => new NginxServiceUpstream(Label(target), target.Port ?? 0),
                { Kind: UpstreamKind.Endpoint } target => new NginxEndpointUpstream(target.Address ?? string.Empty),
                _ => new Unsupported(),
            },
            AllowFrom = settings.AllowFrom ?? [],
            ConnectTimeoutSeconds = settings.ConnectTimeoutSeconds,
            IdleTimeoutSeconds = settings.IdleTimeoutSeconds,
        };
    }

    /// <summary>A stable hash of what a site renders from, so "applied" can be told from "saved".</summary>
    public static string Fingerprint(params string?[] parts)
    {
        var text = string.Join('\u001f', parts.Select(part => part ?? "\u0000"));
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text)));
    }

    public static NginxProblemInfo ToInfo(NginxProblem problem)
    {
        ArgumentNullException.ThrowIfNull(problem);
        return new NginxProblemInfo(problem.Field, problem.Message, problem.Line, NginxTestOutput.SiteIdOf(problem.Field));
    }

    private static NginxUpstream SiteUpstream(UpstreamTarget? target) => target switch
    {
        { Kind: UpstreamKind.ServicePort } service => new NginxServiceUpstream(Label(service), service.Port ?? 0),
        { Kind: UpstreamKind.Url } url => new NginxUrlUpstream(url.Address ?? string.Empty, url.VerifyCertificate, url.SendUpstreamHost),
        _ => new Unsupported(),
    };

    private static string Label(UpstreamTarget target) => string.IsNullOrWhiteSpace(target.Service) ? "local" : target.Service;

    /// <summary>An upstream kind the site or proxy cannot use; the validator reports it.</summary>
    private sealed record Unsupported : NginxUpstream;
}
