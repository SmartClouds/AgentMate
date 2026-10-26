using System.Globalization;
using System.Text.RegularExpressions;

namespace Runova.ServerCore.Registries;

/// <summary>Where a sign-in came from, for the job log and the audit trail.</summary>
internal enum RegistryLoginSource
{
    /// <summary>Sent by the app with this deploy or pull.</summary>
    Request,

    /// <summary>Stored on this server.</summary>
    Stored,
}

/// <summary>One registry sign-in, checked. The secret lives only as long as the job that uses it.</summary>
internal sealed record RegistryLogin(string Registry, string Username, string Secret, RegistryLoginSource Source)
{
    public override string ToString() => $"RegistryLogin {{ Registry = {Registry}, Username = {Username}, Source = {Source} }}";
}

/// <summary>
/// Registry hosts, user names and secrets as the core accepts them. A registry is named by its
/// host (and port), lowercase, the way the docker CLI matches an image to its sign-in; Docker
/// Hub's several names all become docker.io.
/// </summary>
internal static partial class RegistryNames
{
    public const string DockerHub = "docker.io";

    /// <summary>The key the docker CLI files Docker Hub's sign-in under in config.json.</summary>
    public const string DockerHubConfigKey = "https://index.docker.io/v1/";

    public const int MaxUsernameLength = 255;

    public const int MaxSecretLength = 4096;

    /// <summary>More than any deploy needs; the request is refused past this.</summary>
    public const int MaxLoginsPerRequest = 10;

    private static readonly HashSet<string> _dockerHubAliases = new(StringComparer.Ordinal)
    {
        "docker.io", "index.docker.io", "registry-1.docker.io", "registry.hub.docker.com",
    };

    /// <summary>A registry host, with a port when it has one. "https://" and a trailing "/" or "/v1/" are allowed.</summary>
    public static bool TryNormalizeRegistry(string? value, out string host)
    {
        host = string.Empty;
        if (value is not { Length: > 0 and <= 300 })
        {
            return false;
        }

        var text = value.ToLowerInvariant();
        if (text.StartsWith("https://", StringComparison.Ordinal))
        {
            text = text["https://".Length..];
            if (text.EndsWith("/v1/", StringComparison.Ordinal))
            {
                text = text[..^"/v1/".Length];
            }
            else if (text.EndsWith('/'))
            {
                text = text[..^1];
            }
        }

        var match = Host().Match(text);
        if (!match.Success || text.Length > 260)
        {
            return false;
        }

        if (match.Groups["port"].Success
            && (!int.TryParse(match.Groups["port"].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var port) || port is < 1 or > 65535))
        {
            return false;
        }

        host = _dockerHubAliases.Contains(text) ? DockerHub : text;
        return true;
    }

    /// <summary>
    /// The registry an image comes from: its first path part when that looks like a host (a dot, a
    /// port or localhost), Docker Hub otherwise. As the docker CLI decides it.
    /// </summary>
    public static string HostOfRepository(string repository)
    {
        ArgumentNullException.ThrowIfNull(repository);
        var slash = repository.IndexOf('/', StringComparison.Ordinal);
        if (slash < 0)
        {
            return DockerHub;
        }

        var first = repository[..slash];
        if (!first.Contains('.', StringComparison.Ordinal) && !first.Contains(':', StringComparison.Ordinal) && first != "localhost")
        {
            return DockerHub;
        }

        return TryNormalizeRegistry(first, out var host) ? host : first.ToLowerInvariant();
    }

    public static string ConfigKey(string registry) => registry == DockerHub ? DockerHubConfigKey : registry;

    /// <summary>Basic auth joins user and secret with a colon, so a user name cannot have one.</summary>
    public static bool IsUsername(string? value) =>
        value is { Length: > 0 and <= MaxUsernameLength }
        && !value.Contains(':', StringComparison.Ordinal)
        && !value.Any(char.IsControl)
        && value.Trim().Length == value.Length;

    /// <summary>One line, and long enough for the job's redactor to mask it (shorter seeds are ignored there).</summary>
    public static bool IsSecret(string? value) =>
        value is { Length: > 0 and <= MaxSecretLength }
        && value.Trim().Length >= Security.Redactor.MinimumSeedLength
        && !value.Any(char.IsControl);

    [GeneratedRegex(
        @"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::(?<port>[0-9]{1,5}))?\z",
        RegexOptions.CultureInvariant)]
    private static partial Regex Host();
}
