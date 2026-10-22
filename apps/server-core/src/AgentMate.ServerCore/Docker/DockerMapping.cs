using System.Globalization;
using System.Text.Json;
using AgentMate.ServerCore.Contracts;
using Docker.DotNet.Models;

namespace AgentMate.ServerCore.Docker;

/// <summary>Docker.DotNet's models to the core's own types.</summary>
internal static class DockerMapping
{
    /// <summary>
    /// Go's os.FileMode (what the archive API's stat header carries) as a POSIX st_mode: the
    /// type from Go's high bits, then setuid, setgid, sticky and the permission bits.
    /// </summary>
    public static int PosixMode(uint goMode)
    {
        const uint dir = 1u << 31, symlink = 1u << 27, device = 1u << 26, pipe = 1u << 25, socket = 1u << 24;
        const uint setuid = 1u << 23, setgid = 1u << 22, charDevice = 1u << 21, sticky = 1u << 20;
        var type = (goMode & dir) != 0 ? 0x4000
            : (goMode & symlink) != 0 ? 0xA000
            : (goMode & device) != 0 ? (goMode & charDevice) != 0 ? 0x2000 : 0x6000
            : (goMode & pipe) != 0 ? 0x1000
            : (goMode & socket) != 0 ? 0xC000
            : 0x8000;
        return type
            | ((goMode & setuid) != 0 ? 0x800 : 0)
            | ((goMode & setgid) != 0 ? 0x400 : 0)
            | ((goMode & sticky) != 0 ? 0x200 : 0)
            | (int)(goMode & 0x1FF);
    }

    public const string ProjectLabel = "com.docker.compose.project";

    public const string ServiceLabel = "com.docker.compose.service";

    public const string NumberLabel = "com.docker.compose.container-number";

    public const string WorkingDirectoryLabel = "com.docker.compose.project.working_dir";

    private static readonly IReadOnlyDictionary<string, string> _noLabels = new Dictionary<string, string>();

    public static EngineContainer Container(ContainerListResponse container)
    {
        ArgumentNullException.ThrowIfNull(container);
        var labels = container.Labels is { } given ? new Dictionary<string, string>(given, StringComparer.Ordinal) : _noLabels;
        var summary = new ContainerSummary(
            container.ID,
            container.Names?.FirstOrDefault()?.TrimStart('/') ?? container.ID[..Math.Min(12, container.ID.Length)],
            container.Image ?? string.Empty,
            container.ImageID ?? string.Empty,
            State(container.State),
            container.Status ?? string.Empty,
            Health(container.Health?.Status, container.Status),
            UnixMs(container.Created),
            [.. (container.Ports ?? [])
                .Select(port => new ContainerPort(
                    port.PrivatePort,
                    port.Type ?? "tcp",
                    string.IsNullOrEmpty(port.IP) ? null : port.IP,
                    port.PublicPort is ushort host and > 0 ? host : null))
                .Distinct()
                .OrderBy(port => port.PrivatePort)
                .ThenBy(port => port.HostIp, StringComparer.Ordinal)],
            Label(labels, ProjectLabel),
            Label(labels, ServiceLabel),
            int.TryParse(Label(labels, NumberLabel), NumberStyles.Integer, CultureInfo.InvariantCulture, out var number) ? number : null);
        return new EngineContainer(summary, labels);
    }

    public static EngineInspection Inspection(ContainerInspectResponse inspected, ContainerSummary? listed)
    {
        ArgumentNullException.ThrowIfNull(inspected);
        var config = inspected.Config;
        var host = inspected.HostConfig;
        var state = inspected.State;
        IReadOnlyDictionary<string, string> labels = config?.Labels is { } given ? new Dictionary<string, string>(given, StringComparer.Ordinal) : _noLabels;
        var environment = (config?.Env ?? [])
            .Select(entry => entry.Split('=', 2))
            .Select(parts => new KeyValuePair<string, string>(parts[0], parts.Length > 1 ? parts[1] : string.Empty))
            .ToList();
        var summary = listed ?? new ContainerSummary(
            inspected.ID,
            inspected.Name?.TrimStart('/') ?? inspected.ID,
            config?.Image ?? string.Empty,
            inspected.Image ?? string.Empty,
            State(state?.Status),
            state?.Status ?? string.Empty,
            Health(state?.Health?.Status, null),
            UnixMs(inspected.Created),
            [.. InspectPorts(inspected.NetworkSettings?.Ports)],
            Label(labels, ProjectLabel),
            Label(labels, ServiceLabel),
            int.TryParse(Label(labels, NumberLabel), NumberStyles.Integer, CultureInfo.InvariantCulture, out var number) ? number : null);
        var running = state?.Running == true;
        var details = new ContainerDetails(
            summary,
            [.. config?.Cmd ?? []],
            [.. config?.Entrypoint ?? []],
            [.. environment.Select(entry => entry.Key).Distinct(StringComparer.Ordinal)],
            [.. labels.OrderBy(label => label.Key, StringComparer.Ordinal).Select(label => new ContainerLabel(label.Key, label.Value))],
            [.. (inspected.Mounts ?? []).Select(mount => new ContainerMount(
                mount.Type ?? "bind",
                mount.Destination ?? string.Empty,
                mount.RW,
                Blank(mount.Source),
                Blank(mount.Name)))],
            [.. (inspected.NetworkSettings?.Networks ?? new Dictionary<string, EndpointSettings>())
                .OrderBy(network => network.Key, StringComparer.Ordinal)
                .Select(network => new ContainerNetwork(
                    network.Key,
                    Blank(network.Value?.IPAddress),
                    Blank(network.Value?.GlobalIPv6Address),
                    Blank(network.Value?.MacAddress)))],
            RestartPolicy(host?.RestartPolicy),
            (int)inspected.RestartCount,
            config?.Tty == true,
            host?.Privileged == true,
            state?.OOMKilled == true,
            Blank(config?.User),
            Blank(config?.WorkingDir),
            Blank(config?.Hostname),
            DockerTime.ToUnixMs(state?.StartedAt),
            running ? null : DockerTime.ToUnixMs(state?.FinishedAt),
            running || state is null ? null : (int)state.ExitCode,
            Blank(state?.Error),
            host?.Memory is > 0 ? host.Memory : null,
            host?.NanoCPUs is > 0 ? host.NanoCPUs / 1e9 : null);
        return new EngineInspection(details, environment);
    }

    public static StatsReading? Reading(ContainerStatsResponse stats)
    {
        ArgumentNullException.ThrowIfNull(stats);
        // A stopped container's readings carry no time.
        if (stats.Read == default)
        {
            return null;
        }

        var cpu = stats.CPUStats;
        var previous = stats.PreCPUStats;
        var memory = stats.MemoryStats;
        return new StatsReading(
            new DateTimeOffset(DateTime.SpecifyKind(stats.Read.ToUniversalTime(), DateTimeKind.Utc)),
            cpu?.CPUUsage?.TotalUsage ?? 0,
            previous?.CPUUsage?.TotalUsage ?? 0,
            cpu?.SystemUsage ?? 0,
            previous?.SystemUsage ?? 0,
            cpu?.OnlineCPUs ?? 0,
            cpu?.CPUUsage?.PercpuUsage?.Count ?? 0,
            memory?.Usage ?? 0,
            memory?.Limit ?? 0,
            memory?.Stats is { } values ? new Dictionary<string, ulong>(values, StringComparer.Ordinal) : new Dictionary<string, ulong>(),
            [.. (stats.BlkioStats?.IoServiceBytesRecursive ?? []).Select(entry => new BlockIoEntry(entry.Op ?? string.Empty, entry.Value))],
            [.. (stats.Networks ?? new Dictionary<string, NetworkStats>()).Values.Select(network => new NetworkTotals(network.RxBytes, network.TxBytes))],
            stats.PidsStats?.Current ?? 0);
    }

    public static EngineEvent? Event(Message message)
    {
        ArgumentNullException.ThrowIfNull(message);
        var time = message.TimeNano is long nano and > 0 ? nano : (message.Time ?? 0) * 1_000_000_000;
        return new EngineEvent(
            message.Type ?? string.Empty,
            message.Action ?? string.Empty,
            message.Actor?.ID ?? string.Empty,
            time,
            message.Actor?.Attributes is { } attributes ? new Dictionary<string, string>(attributes, StringComparer.Ordinal) : _noLabels);
    }

    public static string? Label(IDictionary<string, string>? labels, string name) =>
        labels is not null && labels.TryGetValue(name, out var value) && value.Length > 0 ? value : null;

    public static string? Label(IReadOnlyDictionary<string, string>? labels, string name) =>
        labels is not null && labels.TryGetValue(name, out var value) && value.Length > 0 ? value : null;

    public static long UnixMs(DateTime time) =>
        time == default ? 0 : new DateTimeOffset(DateTime.SpecifyKind(time.Kind == DateTimeKind.Local ? time.ToUniversalTime() : time, DateTimeKind.Utc)).ToUnixTimeMilliseconds();

    public static ContainerState State(string? state) => state switch
    {
        "created" => ContainerState.Created,
        "running" => ContainerState.Running,
        "paused" => ContainerState.Paused,
        "restarting" => ContainerState.Restarting,
        "removing" => ContainerState.Removing,
        "exited" => ContainerState.Exited,
        "dead" => ContainerState.Dead,
        _ => ContainerState.Unknown,
    };

    /// <summary>From the health status, or from the status text ("Up 3 minutes (healthy)") on older engines.</summary>
    public static ContainerHealth Health(string? health, string? status) => health switch
    {
        "healthy" => ContainerHealth.Healthy,
        "unhealthy" => ContainerHealth.Unhealthy,
        "starting" => ContainerHealth.Starting,
        _ when status?.Contains("(healthy)", StringComparison.Ordinal) == true => ContainerHealth.Healthy,
        _ when status?.Contains("(unhealthy)", StringComparison.Ordinal) == true => ContainerHealth.Unhealthy,
        _ when status?.Contains("(health: starting)", StringComparison.Ordinal) == true => ContainerHealth.Starting,
        _ => ContainerHealth.None,
    };

    private static IEnumerable<ContainerPort> InspectPorts(IDictionary<string, IList<PortBinding>>? ports)
    {
        foreach (var (key, bindings) in ports ?? new Dictionary<string, IList<PortBinding>>())
        {
            var parts = key.Split('/');
            if (!int.TryParse(parts[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out var port))
            {
                continue;
            }

            var protocol = parts.Length > 1 ? parts[1] : "tcp";
            if (bindings is null || bindings.Count == 0)
            {
                yield return new ContainerPort(port, protocol);
                continue;
            }

            foreach (var binding in bindings)
            {
                yield return new ContainerPort(
                    port,
                    protocol,
                    Blank(binding.HostIP),
                    int.TryParse(binding.HostPort, NumberStyles.Integer, CultureInfo.InvariantCulture, out var hostPort) ? hostPort : null);
            }
        }
    }

    private static string RestartPolicy(RestartPolicy? policy)
    {
        if (policy is null)
        {
            return "no";
        }

        var name = JsonNamingPolicy.KebabCaseLower.ConvertName(policy.Name.ToString());
        return name switch
        {
            "undefined" or "" => "no",
            "on-failure" when policy.MaximumRetryCount > 0 => $"on-failure:{policy.MaximumRetryCount}",
            _ => name,
        };
    }

    private static string? Blank(string? value) => string.IsNullOrEmpty(value) ? null : value;
}
