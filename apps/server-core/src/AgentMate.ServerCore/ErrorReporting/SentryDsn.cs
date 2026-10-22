using System.Diagnostics.CodeAnalysis;
using System.Globalization;
using System.Net;
using System.Text.RegularExpressions;

namespace AgentMate.ServerCore.ErrorReporting;

/// <summary>
/// A Sentry DSN taken apart: https://&lt;public key&gt;@&lt;host&gt;[:port][/path prefix]/&lt;project id&gt;. Sentry takes
/// OpenTelemetry logs straight at /api/&lt;project id&gt;/integration/otlp/v1/logs, signed with the public key,
/// so the DSN is all the core needs and no Sentry SDK is involved. The old secret part of a DSN is
/// dropped when read: nothing here uses it. The key is never written by ToString.
/// </summary>
internal sealed partial record SentryDsn(string Scheme, string PublicKey, string Host, int? Port, string PathPrefix, string ProjectId)
{
    public const int MaxLength = 512;

    private const int MaxProjectIdLength = 18;

    /// <summary>The host and port as typed, with an IPv6 address in its brackets.</summary>
    public string Authority => Port is int port ? $"{Host}:{port.ToString(CultureInfo.InvariantCulture)}" : Host;

    /// <summary>Where OTLP logs for this project go.</summary>
    public Uri LogsUri => new($"{Scheme}://{Authority}{PathPrefix}/api/{ProjectId}/integration/otlp/v1/logs");

    /// <summary>The x-sentry-auth header value: it carries the public key.</summary>
    public string AuthHeader => $"sentry sentry_key={PublicKey}";

    /// <summary>Without the key, so it is safe in a log line, an audit row or a test failure.</summary>
    public override string ToString() => $"{Scheme}://{Authority}{PathPrefix}/{ProjectId}";

    /// <summary>The whole DSN, key included. Only for sealing it into the settings file.</summary>
    public string ToSecretString() => $"{Scheme}://{PublicKey}@{Authority}{PathPrefix}/{ProjectId}";

    /// <summary>
    /// Reads a DSN the way the core will use it. Plain http is only for this machine (a Sentry on
    /// loopback, used in development); everything else must be https. The error says what is wrong in
    /// words for the person who pasted it.
    /// </summary>
    public static bool TryParse(string? text, [NotNullWhen(true)] out SentryDsn? dsn, out string error)
    {
        dsn = null;
        var trimmed = text?.Trim() ?? string.Empty;
        if (trimmed.Length == 0)
        {
            error = "Paste the DSN from your Sentry project (Project settings, then Client Keys).";
            return false;
        }

        if (trimmed.Length > MaxLength)
        {
            error = "That DSN is too long.";
            return false;
        }

        var schemeEnd = trimmed.IndexOf("://", StringComparison.Ordinal);
        if (schemeEnd <= 0)
        {
            error = "That is not a Sentry DSN. It looks like https://<public key>@<host>/<project id>.";
            return false;
        }

        var scheme = trimmed[..schemeEnd].ToLowerInvariant();
        if (scheme is not ("https" or "http"))
        {
            error = "The DSN must start with https://.";
            return false;
        }

        var rest = trimmed[(schemeEnd + 3)..];
        if (rest.AsSpan().IndexOfAny('?', '#') >= 0)
        {
            error = "A DSN has no query or fragment part. Copy it again from Client Keys.";
            return false;
        }

        var slash = rest.IndexOf('/', StringComparison.Ordinal);
        var authority = slash < 0 ? rest : rest[..slash];
        var path = slash < 0 ? string.Empty : rest[slash..];

        var at = authority.LastIndexOf('@');
        if (at < 0)
        {
            error = "The DSN has no public key before the host.";
            return false;
        }

        var key = authority[..at].Split(':', 2)[0];
        if (!PublicKeyShape().IsMatch(key))
        {
            error = "The DSN has no valid public key before the host.";
            return false;
        }

        if (!TryHostAndPort(authority[(at + 1)..], out var host, out var port, out error))
        {
            return false;
        }

        if (scheme == "http" && !IsLoopback(host))
        {
            error = "Use an https DSN. Plain http is only allowed for this machine (localhost).";
            return false;
        }

        if (!TryPath(path, out var prefix, out var projectId, out error))
        {
            return false;
        }

        dsn = new SentryDsn(scheme, key, host, port, prefix, projectId);
        error = string.Empty;
        return true;
    }

    private static bool TryHostAndPort(string authority, out string host, out int? port, out string error)
    {
        host = string.Empty;
        port = null;
        error = "The DSN has no valid host after the @.";

        // An IPv6 address sits in brackets and its own colons are not the port's.
        string hostText;
        string? portText = null;
        if (authority.StartsWith('['))
        {
            var close = authority.IndexOf(']', StringComparison.Ordinal);
            if (close < 0)
            {
                return false;
            }

            hostText = authority[..(close + 1)];
            var after = authority[(close + 1)..];
            if (after.Length > 0)
            {
                if (!after.StartsWith(':'))
                {
                    return false;
                }

                portText = after[1..];
            }
        }
        else
        {
            var colon = authority.IndexOf(':', StringComparison.Ordinal);
            hostText = colon < 0 ? authority : authority[..colon];
            portText = colon < 0 ? null : authority[(colon + 1)..];
        }

        hostText = hostText.ToLowerInvariant();
        if (hostText.Length == 0 || Uri.CheckHostName(hostText) is not (UriHostNameType.Dns or UriHostNameType.IPv4 or UriHostNameType.IPv6))
        {
            return false;
        }

        if (portText is not null)
        {
            if (!int.TryParse(portText, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed) || parsed is < 1 or > 65535)
            {
                error = "The port in the DSN must be a number from 1 to 65535.";
                return false;
            }

            port = parsed;
        }

        host = hostText;
        error = string.Empty;
        return true;
    }

    private static bool TryPath(string path, out string prefix, out string projectId, out string error)
    {
        prefix = string.Empty;
        projectId = string.Empty;
        var segments = path.Length == 0 ? [] : path[1..].Split('/');
        var last = segments.Length == 0 ? string.Empty : segments[^1];
        if (last.Length is 0 or > MaxProjectIdLength || !ProjectIdShape().IsMatch(last))
        {
            error = "The DSN needs the project id (a number) at the end.";
            return false;
        }

        var parts = segments[..^1];
        if (parts.Any(part => !PathSegmentShape().IsMatch(part)))
        {
            error = "The path in the DSN has characters a web address cannot hold.";
            return false;
        }

        prefix = parts.Length == 0 ? string.Empty : "/" + string.Join('/', parts);
        projectId = last;
        error = string.Empty;
        return true;
    }

    private static bool IsLoopback(string host) =>
        host == "localhost"
        || (IPAddress.TryParse(host.Trim('[', ']'), out var address) && IPAddress.IsLoopback(address));

    [GeneratedRegex("^[A-Za-z0-9]{6,64}$", RegexOptions.CultureInvariant)]
    private static partial Regex PublicKeyShape();

    [GeneratedRegex("^[0-9]+$", RegexOptions.CultureInvariant)]
    private static partial Regex ProjectIdShape();

    [GeneratedRegex("^[A-Za-z0-9._~-]+$", RegexOptions.CultureInvariant)]
    private static partial Regex PathSegmentShape();
}
