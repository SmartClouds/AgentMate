using System.Collections.Frozen;
using System.Diagnostics.CodeAnalysis;
using System.Globalization;
using System.Net;
using Runova.ServerCore.Hosting;

namespace Runova.ServerCore.Nginx;

/// <summary>Where an upstream URL points, parsed and normalized: render it with <see cref="ToNginx"/>, never from the input.</summary>
internal sealed record UpstreamUrl(string Scheme, string Host, int? Port, string Path)
{
    public bool IsHttps => Scheme == "https";

    /// <summary>The host as it appears in a URL: IPv6 addresses in brackets.</summary>
    public string Authority => (Host.Contains(':', StringComparison.Ordinal) ? $"[{Host}]" : Host)
        + (Port is { } port ? ":" + port.ToString(CultureInfo.InvariantCulture) : string.Empty);

    public string ToNginx() => $"{Scheme}://{Authority}{Path}";
}

/// <summary>A host and port for a TCP or UDP stream proxy.</summary>
internal sealed record UpstreamEndpoint(string Host, int Port)
{
    public string ToNginx() =>
        (Host.Contains(':', StringComparison.Ordinal) ? $"[{Host}]" : Host) + ":" + Port.ToString(CultureInfo.InvariantCulture);
}

/// <summary>
/// Decides where nginx may connect on behalf of a site's visitors. It refuses cloud metadata
/// services and link-local addresses (they hand out the server's credentials), addresses that are
/// not destinations, Unix sockets (the core's own socket or Docker's would give visitors control of
/// the server), variables (a request could then choose the target) and the ports of the core and
/// the Docker API.
/// </summary>
/// <remarks>
/// A host name is checked as written; what it resolves to is not known until nginx loads the
/// configuration. Whoever applies a configuration should resolve upstream names and run the
/// addresses through <see cref="CheckAddress"/> as well.
/// </remarks>
internal sealed class UpstreamPolicy
{
    private const int MaxUrlLength = 2048;

    /// <summary>Names that resolve to a metadata service on the cloud that uses them.</summary>
    private static readonly FrozenSet<string> _metadataNames = FrozenSet.Create(
        StringComparer.Ordinal,
        "metadata",
        "metadata.google.internal",
        "metadata.goog",
        "instance-data",
        "instance-data.ec2.internal",
        "metadata.tencentyun.com");

    private const string Core = "the Runova core";
    private const string DockerApi = "the Docker Engine API";

    private readonly FrozenDictionary<int, string> _reservedPorts;

    /// <param name="reservedPorts">Ports nginx must neither proxy to nor listen on, and what uses each, like "the Runova core".</param>
    public UpstreamPolicy(IReadOnlyDictionary<int, string> reservedPorts)
    {
        ArgumentNullException.ThrowIfNull(reservedPorts);
        _reservedPorts = reservedPorts.ToFrozenDictionary();
    }

    /// <summary>The core's development port and the Docker Engine API's ports.</summary>
    public static UpstreamPolicy Default { get; } = new(DefaultReservedPorts());

    /// <summary>The default policy plus the TCP port the core is configured to listen on, if any.</summary>
    public static UpstreamPolicy For(CoreListenOptions listen)
    {
        ArgumentNullException.ThrowIfNull(listen);
        var ports = DefaultReservedPorts();
        if (listen.TcpPort is { } port)
        {
            ports[port] = Core;
        }

        return new UpstreamPolicy(ports);
    }

    /// <summary>Why nginx must not connect to this address, or null when it may.</summary>
    public static string? CheckAddress(IPAddress address) => NginxAddresses.Refusal(address);

    /// <summary>Why nginx must not connect to this port, or null when it may.</summary>
    public string? CheckPort(int port)
    {
        if (port is < 1 or > 65535)
        {
            return $"{port} is not a port number from 1 to 65535.";
        }

        return _reservedPorts.TryGetValue(port, out var owner)
            ? $"Port {port} belongs to {owner}; a site or proxy in front of it would open {owner} to the internet."
            : null;
    }

    /// <summary>Why nginx must not listen on this port, or null when it may.</summary>
    public string? CheckListenPort(int port)
    {
        if (port is < 1 or > 65535)
        {
            return $"{port} is not a port number from 1 to 65535.";
        }

        return _reservedPorts.TryGetValue(port, out var owner)
            ? $"Port {port} belongs to {owner}, so nginx may not listen on it."
            : null;
    }

    /// <summary>Parses an <c>http://</c> or <c>https://</c> upstream URL and checks where it points.</summary>
    public bool TryParseUrl(string? text, [NotNullWhen(true)] out UpstreamUrl? url, [NotNullWhen(false)] out string? problem)
    {
        url = null;
        text ??= string.Empty;
        var schemeEnd = text.IndexOf("://", StringComparison.Ordinal);
        var scheme = schemeEnd < 0 ? string.Empty : text[..schemeEnd].ToLowerInvariant();
        if (scheme is not ("http" or "https"))
        {
            problem = "The upstream URL must start with http:// or https://.";
            return false;
        }

        if (text.Length > MaxUrlLength)
        {
            problem = $"The upstream URL is longer than {MaxUrlLength} characters.";
            return false;
        }

        var rest = text[(schemeEnd + 3)..];
        if (CommonProblem(rest) is { } common)
        {
            problem = common;
            return false;
        }

        if (rest.Contains('?', StringComparison.Ordinal))
        {
            problem = "The upstream URL may not have a query (?...); nginx passes on the visitor's own.";
            return false;
        }

        if (rest.Contains('#', StringComparison.Ordinal))
        {
            problem = "The upstream URL may not have a fragment (#...), which means nothing to an upstream.";
            return false;
        }

        var pathStart = rest.IndexOf('/', StringComparison.Ordinal);
        var authority = pathStart < 0 ? rest : rest[..pathStart];
        var path = pathStart < 0 ? string.Empty : rest[pathStart..];

        if (authority.Contains('@', StringComparison.Ordinal))
        {
            problem = "The upstream URL may not carry a user name or password; nginx would not send them.";
            return false;
        }

        if (!TryParseHostAndPort(authority, portRequired: false, out var host, out var port, out problem))
        {
            return false;
        }

        if (PathProblem(path) is { } pathProblem)
        {
            problem = pathProblem;
            return false;
        }

        if (CheckPort(port ?? (scheme == "https" ? 443 : 80)) is { } portProblem)
        {
            problem = portProblem;
            return false;
        }

        url = new UpstreamUrl(scheme, host, port, path);
        return true;
    }

    /// <summary>Parses a <c>host:port</c> target for a stream proxy and checks where it points.</summary>
    public bool TryParseEndpoint(string? text, [NotNullWhen(true)] out UpstreamEndpoint? endpoint, [NotNullWhen(false)] out string? problem)
    {
        endpoint = null;
        text ??= string.Empty;
        if (CommonProblem(text) is { } common)
        {
            problem = common;
            return false;
        }

        if (text.Contains('/', StringComparison.Ordinal) || text.Contains('@', StringComparison.Ordinal))
        {
            problem = $"'{text}' is not a host and port like 127.0.0.1:5432.";
            return false;
        }

        if (!TryParseHostAndPort(text, portRequired: true, out var host, out var port, out problem))
        {
            return false;
        }

        if (CheckPort(port!.Value) is { } portProblem)
        {
            problem = portProblem;
            return false;
        }

        endpoint = new UpstreamEndpoint(host, port.Value);
        return true;
    }

    private static Dictionary<int, string> DefaultReservedPorts() => new()
    {
        [CoreListenOptions.DefaultDevelopmentPort] = Core,
        [2375] = DockerApi,
        [2376] = DockerApi,
    };

    /// <summary>Checks that hold for URLs and endpoints alike, worded for the one thing the user got wrong.</summary>
    private static string? CommonProblem(string text)
    {
        if (text.Contains('$', StringComparison.Ordinal))
        {
            return "The upstream may not use nginx variables ($...), since a request could then choose where nginx connects.";
        }

        if (text.StartsWith("unix:", StringComparison.OrdinalIgnoreCase))
        {
            return "Unix socket upstreams are not allowed: a socket like the core's or Docker's would give the site's visitors control of this server.";
        }

        foreach (var c in text)
        {
            if (char.IsWhiteSpace(c) || char.IsControl(c))
            {
                return "The upstream may not contain spaces or control characters.";
            }

            if (c > '~')
            {
                return "The upstream may only contain ASCII characters; write international names in their xn-- form.";
            }

            if (c is ';' or '{' or '}' or '"' or '\'' or '\\' or '<' or '>' or '^' or '`' or '|')
            {
                return $"The upstream may not contain the character '{c}'.";
            }
        }

        return null;
    }

    private static bool TryParseHostAndPort(
        string authority,
        bool portRequired,
        [NotNullWhen(true)] out string? host,
        out int? port,
        [NotNullWhen(false)] out string? problem)
    {
        host = null;
        port = null;
        string hostText;
        string? portText = null;

        if (authority.StartsWith('['))
        {
            var close = authority.IndexOf(']', StringComparison.Ordinal);
            if (close < 0)
            {
                problem = $"'{authority}' opens an IPv6 address with '[' but never closes it.";
                return false;
            }

            hostText = authority[1..close];
            var after = authority[(close + 1)..];
            if (after.Length > 0)
            {
                if (after[0] != ':')
                {
                    problem = $"'{authority}' has something other than a port after the IPv6 address.";
                    return false;
                }

                portText = after[1..];
            }

            if (hostText.Contains('%', StringComparison.Ordinal))
            {
                problem = "IPv6 zone indexes (%...) are not supported in upstreams.";
                return false;
            }

            if (!NginxAddresses.TryParseIPv6(hostText, out var v6))
            {
                problem = $"'{hostText}' is not an IPv6 address.";
                return false;
            }

            if (NginxAddresses.Refusal(v6) is { } refusal)
            {
                problem = refusal;
                return false;
            }

            host = v6.ToString();
        }
        else
        {
            var colon = authority.LastIndexOf(':');
            if (colon >= 0)
            {
                hostText = authority[..colon];
                portText = authority[(colon + 1)..];
            }
            else
            {
                hostText = authority;
            }

            if (hostText.Length == 0)
            {
                problem = "The upstream has no host.";
                return false;
            }

            if (hostText.Contains(':', StringComparison.Ordinal))
            {
                problem = $"'{authority}' looks like an IPv6 address; write it in brackets, like [2001:db8::1]:8080.";
                return false;
            }

            if (NginxAddresses.TryParseIPv4(hostText, out var v4))
            {
                if (NginxAddresses.Refusal(v4) is { } refusal)
                {
                    problem = refusal;
                    return false;
                }

                host = v4.ToString();
            }
            else
            {
                var name = hostText.ToLowerInvariant();
                if (name.EndsWith('.'))
                {
                    name = name[..^1];
                }

                if (NginxNames.HostNameProblem(name) is { } nameProblem)
                {
                    problem = nameProblem;
                    return false;
                }

                if (_metadataNames.Contains(name))
                {
                    problem = $"'{name}' is a cloud metadata service name; the service hands out this server's credentials.";
                    return false;
                }

                host = name;
            }
        }

        if (portText is null)
        {
            if (portRequired)
            {
                problem = $"'{authority}' needs a port, like {authority}:5432.";
                return false;
            }

            problem = null;
            return true;
        }

        if (portText.Length is 0 or > 5
            || !portText.All(char.IsAsciiDigit)
            || portText[0] == '0'
            || !int.TryParse(portText, NumberStyles.None, CultureInfo.InvariantCulture, out var value)
            || value > 65535)
        {
            problem = $"'{portText}' is not a port number from 1 to 65535.";
            return false;
        }

        port = value;
        problem = null;
        return true;
    }

    /// <summary>
    /// Paths are plain RFC 3986 path characters with valid percent-escapes. Dot segments are
    /// refused because what they mean depends on who normalizes the path.
    /// </summary>
    private static string? PathProblem(string path)
    {
        if (path.Length == 0)
        {
            return null;
        }

        for (var i = 0; i < path.Length; i++)
        {
            var c = path[i];
            if (c == '%')
            {
                if (i + 2 >= path.Length || !char.IsAsciiHexDigit(path[i + 1]) || !char.IsAsciiHexDigit(path[i + 2]))
                {
                    return "The upstream path has a broken percent-escape; % must be followed by two hex digits.";
                }

                continue;
            }

            if (!(char.IsAsciiLetterOrDigit(c) || "-._~!&()*+,=:@/".Contains(c, StringComparison.Ordinal)))
            {
                return $"The upstream path may not contain the character '{c}'.";
            }
        }

        if (path.Split('/').Any(segment => segment is "." or ".."))
        {
            return "The upstream path may not contain . or .. segments.";
        }

        return null;
    }
}
