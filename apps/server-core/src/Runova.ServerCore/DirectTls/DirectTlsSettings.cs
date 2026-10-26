using System.Net;
using System.Text.Json;
using Runova.ServerCore.Firewall;

namespace Runova.ServerCore.DirectTls;

/// <summary>
/// Whether the direct TLS listener is on, on which port, and for which source networks. Kept in the
/// core's own state folder (root only) rather than core.json, which the installer owns.
/// </summary>
internal sealed record DirectTlsSettings(bool Enabled, int Port, string[] Sources, long? ChangedAt = null, string? ChangedBy = null)
{
    public const int DefaultPort = 7443;

    public const int MaxSources = 16;

    public static DirectTlsSettings Off { get; } = new(false, DefaultPort, []);

    /// <summary>The sources as networks; empty means anywhere. Only call on validated settings.</summary>
    public IPNetwork[] Networks() =>
        [.. Sources.Select(source => FirewallAddresses.TryParseNetwork(source, out var network, out _) ? network : throw new InvalidOperationException($"'{source}' is not a network."))];

    /// <summary>Checks a request the way the core reads it; null when it is fine.</summary>
    public static string? Validate(int port, string[]? sources, IReadOnlyCollection<int> sshPorts, out string[] normalized)
    {
        ArgumentNullException.ThrowIfNull(sshPorts);
        normalized = [];
        if (port is < 1 or > 65535)
        {
            return "The port must be a number from 1 to 65535.";
        }

        if (port < 1024)
        {
            return "Pick a port from 1024 up. The ones below are kept for well-known services such as SSH and HTTPS.";
        }

        if (sshPorts.Contains(port))
        {
            return $"Port {port} is the SSH port. Pick another one.";
        }

        var list = sources ?? [];
        if (list.Length > MaxSources)
        {
            return $"At most {MaxSources} source addresses or networks.";
        }

        var seen = new List<string>();
        foreach (var source in list)
        {
            if (!FirewallAddresses.TryParseNetwork(source, out var network, out var error))
            {
                return error;
            }

            if (FirewallAddresses.IsEverything(network))
            {
                return "Leave the sources empty to allow every address, rather than a network that covers them all.";
            }

            var text = FirewallAddresses.Format(network);
            if (!seen.Contains(text, StringComparer.Ordinal))
            {
                seen.Add(text);
            }
        }

        normalized = [.. seen];
        return null;
    }

    /// <summary>Whether an address may connect: everything when no source is set.</summary>
    public static bool Allows(IReadOnlyList<IPNetwork> networks, IPAddress? remote)
    {
        ArgumentNullException.ThrowIfNull(networks);
        if (networks.Count == 0)
        {
            return true;
        }

        if (remote is null)
        {
            return false;
        }

        var address = FirewallAddresses.Normalize(remote);
        return networks.Any(network => network.Contains(address));
    }

    public static DirectTlsSettings Read(string path)
    {
        ArgumentNullException.ThrowIfNull(path);
        if (!File.Exists(path))
        {
            return Off;
        }

        try
        {
            var stored = JsonSerializer.Deserialize<Stored>(File.ReadAllText(path), CoreJson.Options);
            if (stored is null || Validate(stored.Port, stored.Sources, [], out var sources) is not null)
            {
                return Off;
            }

            return new DirectTlsSettings(stored.Enabled, stored.Port, sources, stored.ChangedAt, stored.ChangedBy);
        }
        catch (JsonException)
        {
            // A file nobody can read again turns the listener off rather than guessing.
            return Off;
        }
    }

    public void Write(string path)
    {
        ArgumentNullException.ThrowIfNull(path);
        var directory = Path.GetDirectoryName(path)!;
        Directory.CreateDirectory(directory);
        var temporary = $"{path}.{Guid.NewGuid():N}.tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(new Stored(Enabled, Port, Sources, ChangedAt, ChangedBy), CoreJson.Options));
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(temporary, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }

        File.Move(temporary, path, overwrite: true);
    }

    private sealed record Stored(bool Enabled, int Port, string[]? Sources, long? ChangedAt, string? ChangedBy);
}
