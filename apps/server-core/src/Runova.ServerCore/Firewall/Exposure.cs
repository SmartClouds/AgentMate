using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using System.Text.RegularExpressions;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Platform;

namespace Runova.ServerCore.Firewall;

/// <summary>A listening socket from `ss`. A null address is ss's "*": every address of both families.</summary>
internal sealed record ListeningSocket(FirewallProtocol Protocol, IPAddress? Address, string Shown, int Port, string? Process, int? Pid);

/// <summary>A port Docker publishes on the host.</summary>
internal sealed record ContainerBinding(
    string ContainerId,
    string ContainerName,
    string Image,
    FirewallProtocol Protocol,
    IPAddress HostAddress,
    PortRange HostPorts,
    PortRange ContainerPorts);

/// <summary>What listens on the server and what Docker publishes, each judged public or not.</summary>
internal interface IExposureSource
{
    Task<ExposureInventory> ReadAsync(CancellationToken cancellationToken);
}

internal static partial class ExposureParsers
{
    /// <summary>A public address no rule is likely to name, for judging rules that hold for anywhere.</summary>
    private static readonly IPAddress _anyoneV4 = IPAddress.Parse("198.51.100.200");

    private static readonly IPAddress _anyoneV6 = IPAddress.Parse("2001:db8:ffff::200");

    /// <summary>`ss -tlnpH` or `ss -ulnpH`: state, queues, local address:port, peer, and the processes.</summary>
    public static IReadOnlyList<ListeningSocket> ParseSockets(string output, FirewallProtocol protocol)
    {
        ArgumentNullException.ThrowIfNull(output);
        var sockets = new List<ListeningSocket>();
        foreach (var line in output.Split('\n'))
        {
            var fields = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (fields.Length < 5 || ParseLocal(fields[3]) is not var (address, shown, port))
            {
                continue;
            }

            string? process = null;
            int? pid = null;
            if (fields.Length > 5 && FirstProcess().Match(string.Join(' ', fields.Skip(5))) is { Success: true } match)
            {
                process = match.Groups["name"].Value;
                pid = int.Parse(match.Groups["pid"].Value, NumberStyles.None, CultureInfo.InvariantCulture);
            }

            sockets.Add(new ListeningSocket(protocol, address, shown, port, process, pid));
        }

        return sockets;
    }

    /// <summary>`docker ps --no-trunc --format '{{json .}}'`: one container per line, its published ports in Ports.</summary>
    public static IReadOnlyList<ContainerBinding> ParseContainers(string output)
    {
        ArgumentNullException.ThrowIfNull(output);
        var bindings = new List<ContainerBinding>();
        foreach (var line in output.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            string id, name, image, ports;
            try
            {
                using var json = JsonDocument.Parse(line);
                var root = json.RootElement;
                id = Text(root, "ID");
                name = Text(root, "Names").Split(',')[0];
                image = Text(root, "Image");
                ports = Text(root, "Ports");
            }
            catch (JsonException)
            {
                continue;
            }

            foreach (var published in ports.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                if (ParseBinding(published) is var (host, hostPorts, containerPorts, protocol))
                {
                    bindings.Add(new ContainerBinding(id.Length > 12 ? id[..12] : id, name, image, protocol, host, hostPorts, containerPorts));
                }
            }
        }

        return bindings;
    }

    public static ExposureScope Scope(IPAddress? address)
    {
        if (address is null || address.Equals(IPAddress.Any) || address.Equals(IPAddress.IPv6Any))
        {
            return ExposureScope.Public;
        }

        address = FirewallAddresses.Normalize(address);
        if (IPAddress.IsLoopback(address))
        {
            return ExposureScope.Local;
        }

        return NetworkAddresses.IsPublic(address) || IsDocumentation(address) ? ExposureScope.Public : ExposureScope.Private;
    }

    /// <summary>
    /// What the firewall makes of a port open on that address, judged by the rules that hold for
    /// anywhere: open, open to some addresses only, or closed. A loopback address is out of reach.
    /// </summary>
    public static ExposureFirewall Judge(FirewallState? firewall, FirewallProtocol protocol, IPAddress? address, int port)
    {
        if (Scope(address) == ExposureScope.Local)
        {
            return ExposureFirewall.NotApplicable;
        }

        if (firewall is null || !firewall.Active)
        {
            return ExposureFirewall.Off;
        }

        // Rules for one address or network do not make a port open to anyone; set them aside first.
        var anywhere = firewall with { Rules = [.. firewall.Rules.Where(rule => rule.Source is null)] };
        var families = address switch
        {
            null => [_anyoneV4, _anyoneV6],
            _ when address.Equals(IPAddress.IPv6Any) => [_anyoneV4, _anyoneV6],
            _ => address.AddressFamily == AddressFamily.InterNetworkV6 && !address.IsIPv4MappedToIPv6 ? new[] { _anyoneV6 } : [_anyoneV4],
        };
        if (families.Any(source => FirewallEvaluation.Evaluate(anywhere, new Probe(source, port, protocol)).Allowed))
        {
            return ExposureFirewall.Open;
        }

        var someone = firewall.Rules.Any(rule => rule is { Source: not null, SourceNegated: false, Outgoing: false, Routed: false }
            && !FirewallEvaluation.Blocks(rule)
            && (rule.Protocol == FirewallProtocol.Any || rule.Protocol == protocol)
            && (rule.Ports is null || rule.Ports.Value.Contains(port))
            && (rule.PortList is not { Count: > 0 } list || list.Any(range => range.Contains(port))));
        return someone ? ExposureFirewall.Restricted : ExposureFirewall.Closed;
    }

    /// <summary>"0.0.0.0:22", "[::]:22", "*:3000", "127.0.0.53%lo:53", "[fe80::1]%eth0:546".</summary>
    private static (IPAddress? Address, string Shown, int Port)? ParseLocal(string text)
    {
        var colon = text.LastIndexOf(':');
        if (colon <= 0 || !int.TryParse(text[(colon + 1)..], NumberStyles.None, CultureInfo.InvariantCulture, out var port) || port is < 1 or > 65535)
        {
            return null;
        }

        var host = text[..colon];
        if (host == "*")
        {
            return (null, "*", port);
        }

        var shown = host;
        var percent = host.IndexOf('%', StringComparison.Ordinal);
        if (percent >= 0)
        {
            host = host[..percent];
        }

        host = host.Trim('[', ']');
        return FirewallAddresses.TryParseAddress(host, out var address) ? (FirewallAddresses.Normalize(address), shown, port) : null;
    }

    /// <summary>"0.0.0.0:8000-8002->8000-8002/tcp", "[::]:5432->5432/tcp", ":::5432->5432/tcp"; "80/tcp" is not published.</summary>
    private static (IPAddress Host, PortRange HostPorts, PortRange ContainerPorts, FirewallProtocol Protocol)? ParseBinding(string text)
    {
        var arrow = text.IndexOf("->", StringComparison.Ordinal);
        var slash = text.LastIndexOf('/');
        if (arrow <= 0 || slash < arrow)
        {
            return null;
        }

        var protocol = text[(slash + 1)..] switch
        {
            "tcp" => FirewallProtocol.Tcp,
            "udp" => FirewallProtocol.Udp,
            _ => (FirewallProtocol?)null,
        };
        var hostPart = text[..arrow];
        var colon = hostPart.LastIndexOf(':');
        if (protocol is null
            || colon <= 0
            || Range(hostPart[(colon + 1)..]) is not { } hostPorts
            || Range(text[(arrow + 2)..slash]) is not { } containerPorts)
        {
            return null;
        }

        var hostText = hostPart[..colon].Trim('[', ']');
        if (hostText == "::")
        {
            return (IPAddress.IPv6Any, hostPorts, containerPorts, protocol.Value);
        }

        return FirewallAddresses.TryParseAddress(hostText, out var host) ? (host, hostPorts, containerPorts, protocol.Value) : null;
    }

    private static PortRange? Range(string text)
    {
        var parts = text.Split('-');
        return parts.Length is 1 or 2
            && int.TryParse(parts[0], NumberStyles.None, CultureInfo.InvariantCulture, out var from)
            && int.TryParse(parts[^1], NumberStyles.None, CultureInfo.InvariantCulture, out var to)
            && from is >= 1 and <= 65535 && to >= from && to <= 65535
            ? new PortRange(from, to)
            : null;
    }

    private static string Text(JsonElement root, string name) =>
        root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() ?? string.Empty : string.Empty;

    /// <summary>The documentation ranges count as public: they stand in for public addresses.</summary>
    private static bool IsDocumentation(IPAddress address) =>
        address.AddressFamily == AddressFamily.InterNetworkV6
            ? address.GetAddressBytes() is [0x20, 0x01, 0x0d, 0xb8, ..]
            : address.GetAddressBytes() is [192, 0, 2, _] or [198, 51, 100, _] or [203, 0, 113, _];

    [GeneratedRegex("""\(\("(?<name>[^"]{1,64})",pid=(?<pid>[0-9]{1,9}),""", RegexOptions.CultureInvariant)]
    private static partial Regex FirstProcess();
}

/// <summary>
/// The exposure inventory: `ss` for the listening sockets, `docker ps` for published container
/// ports (none when Docker is not installed), and the firewall's rules to say what gets through.
/// Ports Docker publishes bypass the host firewall, which is why they are flagged on their own.
/// </summary>
internal sealed class ExposureInventorySource(IProcessRunner runner, IFirewallBackendSource firewall, TimeProvider time) : IExposureSource
{
    public async Task<ExposureInventory> ReadAsync(CancellationToken cancellationToken)
    {
        FirewallState? state;
        try
        {
            state = await firewall.Current().ReadAsync(cancellationToken);
        }
        catch (Exception failure) when (failure is ProcessStartException or ProcessFailedException or IOException or UnauthorizedAccessException)
        {
            state = null;
        }

        var sockets = new List<ListeningSocketInfo>();
        string? socketsError = null;
        foreach (var (flags, protocol) in new[] { ("-tlnpH", FirewallProtocol.Tcp), ("-ulnpH", FirewallProtocol.Udp) })
        {
            var (output, error) = await RunAsync("ss", [flags], cancellationToken);
            if (output is null)
            {
                socketsError ??= error;
                continue;
            }

            sockets.AddRange(ExposureParsers.ParseSockets(output, protocol).Select(socket => new ListeningSocketInfo(
                socket.Protocol,
                socket.Shown,
                socket.Port,
                ExposureParsers.Scope(socket.Address),
                socket.Process == "docker-proxy" && ExposureParsers.Scope(socket.Address) != ExposureScope.Local
                    ? ExposureFirewall.Bypassed
                    : ExposureParsers.Judge(state, socket.Protocol, socket.Address, socket.Port),
                socket.Process,
                socket.Pid)));
        }

        var containers = new List<ContainerPortInfo>();
        var dockerAvailable = true;
        string? dockerError = null;
        try
        {
            var (output, error) = await RunAsync("docker", ["ps", "--no-trunc", "--format", "{{json .}}"], cancellationToken, missingThrows: true);
            if (output is null)
            {
                dockerError = error;
            }
            else
            {
                containers.AddRange(ExposureParsers.ParseContainers(output).Select(binding =>
                {
                    var scope = ExposureParsers.Scope(binding.HostAddress);
                    return new ContainerPortInfo(
                        binding.ContainerId,
                        binding.ContainerName,
                        binding.Image,
                        binding.Protocol,
                        binding.HostAddress.ToString(),
                        binding.HostPorts.From,
                        binding.ContainerPorts.From,
                        scope,
                        scope == ExposureScope.Local ? ExposureFirewall.NotApplicable : ExposureFirewall.Bypassed,
                        binding.HostPorts.IsSingle ? null : binding.HostPorts.To,
                        binding.ContainerPorts.IsSingle ? null : binding.ContainerPorts.To);
                }));
            }
        }
        catch (ProcessStartException)
        {
            dockerAvailable = false;
        }

        return new ExposureInventory(
            [.. sockets],
            [.. containers],
            dockerAvailable,
            time.GetUtcNow().ToUnixTimeMilliseconds(),
            socketsError,
            dockerError);
    }

    /// <summary>The output, or null and why. A missing program is an answer too, unless the caller wants to know.</summary>
    private async Task<(string? Output, string? Error)> RunAsync(
        string program,
        string[] arguments,
        CancellationToken cancellationToken,
        bool missingThrows = false)
    {
        try
        {
            var result = await runner.RunAsync(
                new ProcessSpec { Program = program, Arguments = arguments, Timeout = TimeSpan.FromSeconds(30), MaxOutputBytes = 4 * 1024 * 1024 },
                onLine: null,
                cancellationToken);
            if (result.Succeeded)
            {
                return (result.StandardOutput, null);
            }

            var said = FirewallSteps.Lines(result.StandardError).Concat(FirewallSteps.Lines(result.StandardOutput)).FirstOrDefault();
            return (null, $"{program} failed{(said is null ? $" (exit code {result.ExitCode})" : $": {said}")}");
        }
        catch (ProcessStartException missing) when (!missingThrows)
        {
            return (null, missing.Message);
        }
    }
}
