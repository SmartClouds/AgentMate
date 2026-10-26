using System.Globalization;
using System.Net;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Execution;

namespace Runova.ServerCore.Firewall;

/// <summary>
/// One SSH connection as the server sees it, in `$SSH_CONNECTION`'s order: the client's address
/// and port, then the server's. The client port tells two connections from the same computer apart.
/// </summary>
internal sealed record SshEndpoint(IPAddress Client, int ClientPort, IPAddress Server, int ServerPort)
{
    /// <summary>The same for the same connection, different for any other.</summary>
    public string Key => $"ssh {Client} {ClientPort.ToString(CultureInfo.InvariantCulture)} {Server} {ServerPort.ToString(CultureInfo.InvariantCulture)}";

    public static bool TryParse(string? text, out SshEndpoint endpoint)
    {
        endpoint = null!;
        if (string.IsNullOrWhiteSpace(text) || text.Length > 200)
        {
            return false;
        }

        var fields = text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        if (fields.Length != 4
            || !TryAddress(fields[0], out var client)
            || !TryPort(fields[1], out var clientPort)
            || !TryAddress(fields[2], out var server)
            || !TryPort(fields[3], out var serverPort))
        {
            return false;
        }

        endpoint = new SshEndpoint(client, clientPort, server, serverPort);
        return true;
    }

    /// <summary>sshd writes a link-local address with its zone (fe80::1%eth0); the zone does not matter here.</summary>
    private static bool TryAddress(string text, out IPAddress address)
    {
        var percent = text.IndexOf('%', StringComparison.Ordinal);
        var bare = percent < 0 ? text : text[..percent];
        if (!FirewallAddresses.TryParseAddress(bare, out var parsed))
        {
            address = IPAddress.None;
            return false;
        }

        address = FirewallAddresses.Normalize(parsed);
        return true;
    }

    private static bool TryPort(string text, out int port) =>
        int.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out port) && port is >= 1 and <= 65535;
}

/// <summary>The ports sshd listens on, from its effective settings (`sshd -T`).</summary>
internal interface ISshdSettings
{
    Task<SshPortsInfo> ReadAsync(CancellationToken cancellationToken);
}

/// <summary>
/// `sshd -T` prints sshd's settings as it would run with them: a `port` line per port and the
/// `listenaddress` lines with theirs. On Ubuntu 24.04 sshd can start from ssh.socket, whose ports
/// may differ, so these are advice; the port of the app's own connection is what counts.
/// </summary>
internal sealed class SshdSettings(IProcessRunner runner) : ISshdSettings
{
    public async Task<SshPortsInfo> ReadAsync(CancellationToken cancellationToken)
    {
        ProcessResult result;
        try
        {
            result = await runner.RunAsync(
                new ProcessSpec { Program = "sshd", Arguments = ["-T"], Timeout = TimeSpan.FromSeconds(15), MaxOutputBytes = 256 * 1024 },
                onLine: null,
                cancellationToken);
        }
        catch (ProcessStartException missing)
        {
            return new SshPortsInfo([], $"sshd could not be asked: {missing.Message}");
        }

        if (!result.Succeeded)
        {
            var said = FirewallSteps.Lines(result.StandardError).Concat(FirewallSteps.Lines(result.StandardOutput)).FirstOrDefault();
            return new SshPortsInfo([], $"sshd -T failed{(said is null ? $" (exit code {result.ExitCode})" : $": {said}")}");
        }

        var ports = Ports(result.StandardOutput);
        return ports.Count == 0
            ? new SshPortsInfo([], "sshd -T named no port.")
            : new SshPortsInfo([.. ports]);
    }

    /// <summary>Every `port N` and the port of every `listenaddress host:port`, in order, once each.</summary>
    public static IReadOnlyList<int> Ports(string output)
    {
        ArgumentNullException.ThrowIfNull(output);
        var ports = new List<int>();
        foreach (var raw in output.Split('\n'))
        {
            var line = raw.Trim();
            var space = line.IndexOf(' ', StringComparison.Ordinal);
            if (space < 0)
            {
                continue;
            }

            var key = line[..space];
            var value = line[(space + 1)..].Trim();
            var portText = key switch
            {
                "port" => value,
                "listenaddress" when value.LastIndexOf(':') is var colon and > 0 => value[(colon + 1)..],
                _ => null,
            };
            if (portText is not null
                && int.TryParse(portText, NumberStyles.None, CultureInfo.InvariantCulture, out var port)
                && port is >= 1 and <= 65535
                && !ports.Contains(port))
            {
                ports.Add(port);
            }
        }

        return ports;
    }
}
