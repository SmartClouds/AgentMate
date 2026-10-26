using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using Runova.ServerCore.Registries;

namespace Runova.ServerCore.Docker;

/// <summary>
/// Private registries on the pretend engine (E08): a registry listed here refuses pulls unless they
/// sign in with its user and secret, through a pull's X-Registry-Auth (a login) or, for docker
/// compose, the config.json in the DOCKER_CONFIG folder the call names.
/// </summary>
internal sealed partial class InMemoryDockerEngine
{
    /// <summary>Registry host (canonical, such as ghcr.io) to the only sign-in it accepts.</summary>
    public ConcurrentDictionary<string, (string Username, string Secret)> PrivateRegistries { get; } = new(StringComparer.Ordinal);

    public bool SignedIn(string registry, string? username, string? secret) =>
        !PrivateRegistries.TryGetValue(registry, out var expected)
        || (string.Equals(expected.Username, username, StringComparison.Ordinal) && string.Equals(expected.Secret, secret, StringComparison.Ordinal));

    /// <summary>Whether the DOCKER_CONFIG folder signs in to the registry, read the way the docker CLI reads it.</summary>
    public bool SignedInWith(string registry, string? dockerConfig)
    {
        if (!PrivateRegistries.ContainsKey(registry))
        {
            return true;
        }

        var file = dockerConfig is null ? null : Path.Combine(dockerConfig, RegistryAuthFolders.ConfigFileName);
        if (file is null || !File.Exists(file))
        {
            return false;
        }

        try
        {
            using var config = JsonDocument.Parse(File.ReadAllText(file));
            if (!config.RootElement.TryGetProperty("auths", out var auths)
                || !auths.TryGetProperty(RegistryNames.ConfigKey(registry), out var entry)
                || !entry.TryGetProperty("auth", out var auth))
            {
                return false;
            }

            var pair = Encoding.UTF8.GetString(Convert.FromBase64String(auth.GetString() ?? string.Empty));
            var colon = pair.IndexOf(':', StringComparison.Ordinal);
            return colon > 0 && SignedIn(registry, pair[..colon], pair[(colon + 1)..]);
        }
        catch (Exception error) when (error is JsonException or FormatException)
        {
            return false;
        }
    }
}
