using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.Docker;

/// <summary>
/// Turns an engine stats reading into what `docker stats` shows, with the Docker CLI's own
/// formulas (cli/command/container/stats_helpers.go), so the app and the terminal agree:
/// <list type="bullet">
/// <item>CPU: the container's CPU delta over the system's since the engine's previous reading,
/// times the online CPUs (the per-CPU counters' count when the engine does not say), times 100.</item>
/// <item>Memory: usage minus total_inactive_file on cgroup v1, minus inactive_file on cgroup v2,
/// whichever applies and is smaller than the usage.</item>
/// <item>Network and block IO: totals since the container started, block IO split by the op's
/// first letter as the CLI does (Total, Sync and Async are not counted).</item>
/// </list>
/// </summary>
internal static class DockerStatsMath
{
    public static ContainerStatsSample Sample(string containerId, StatsReading reading, long atUnixMs)
    {
        ArgumentNullException.ThrowIfNull(reading);
        var online = reading.OnlineCpus > 0 ? (int)reading.OnlineCpus : reading.PerCpuCount;
        var used = MemoryUsed(reading);
        var (read, written) = BlockIo(reading.BlockIo);
        ulong received = 0;
        ulong transmitted = 0;
        foreach (var network in reading.Networks)
        {
            received += network.ReceivedBytes;
            transmitted += network.TransmittedBytes;
        }

        return new ContainerStatsSample(
            containerId,
            atUnixMs,
            CpuPercent(reading, online),
            online,
            Clamp(used),
            Clamp(reading.MemoryLimit),
            reading.MemoryLimit == 0 ? 0 : (double)used / reading.MemoryLimit * 100.0,
            Clamp(received),
            Clamp(transmitted),
            Clamp(read),
            Clamp(written),
            Clamp(reading.Pids));
    }

    private static double CpuPercent(StatsReading reading, int online)
    {
        var cpuDelta = (double)reading.CpuTotal - reading.PreCpuTotal;
        var systemDelta = (double)reading.SystemCpu - reading.PreSystemCpu;
        return systemDelta > 0.0 && cpuDelta > 0.0 ? cpuDelta / systemDelta * online * 100.0 : 0.0;
    }

    private static ulong MemoryUsed(StatsReading reading)
    {
        var usage = reading.MemoryUsage;
        if (reading.MemoryStats.TryGetValue("total_inactive_file", out var v1) && v1 < usage)
        {
            return usage - v1;
        }

        var v2 = reading.MemoryStats.GetValueOrDefault("inactive_file");
        return v2 < usage ? usage - v2 : usage;
    }

    private static (ulong Read, ulong Written) BlockIo(IReadOnlyList<BlockIoEntry> entries)
    {
        ulong read = 0;
        ulong written = 0;
        foreach (var entry in entries)
        {
            if (string.IsNullOrEmpty(entry.Op))
            {
                continue;
            }

            switch (entry.Op[0])
            {
                case 'r' or 'R':
                    read += entry.Value;
                    break;
                case 'w' or 'W':
                    written += entry.Value;
                    break;
            }
        }

        return (read, written);
    }

    private static long Clamp(ulong value) => value > long.MaxValue ? long.MaxValue : (long)value;
}
