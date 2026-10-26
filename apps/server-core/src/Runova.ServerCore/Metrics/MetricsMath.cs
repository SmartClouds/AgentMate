using Runova.ServerCore.Contracts;
using Runova.ServerCore.Platform;

namespace Runova.ServerCore.Metrics;

/// <summary>Turns two readings into a sample, and many samples into one average.</summary>
internal static class MetricsMath
{
    public static MetricsSample Sample(
        SystemCounters before,
        SystemCounters after,
        double elapsedSeconds,
        long atUnixMs,
        (long Total, long Used) rootDisk)
    {
        ArgumentNullException.ThrowIfNull(before);
        ArgumentNullException.ThrowIfNull(after);
        var cpu = CpuTimes.Usage(before.Cpu, after.Cpu);
        return new MetricsSample(
            atUnixMs,
            cpu.BusyPercent,
            cpu.IowaitPercent,
            cpu.StealPercent,
            after.Load.One,
            after.Load.Five,
            after.Load.Fifteen,
            after.Memory.TotalBytes,
            after.Memory.UsedBytes,
            after.Memory.SwapTotalBytes,
            after.Memory.SwapUsedBytes,
            Rate(before.Network.ReceivedBytes, after.Network.ReceivedBytes, elapsedSeconds),
            Rate(before.Network.TransmittedBytes, after.Network.TransmittedBytes, elapsedSeconds),
            Rate(before.Disk.ReadBytes, after.Disk.ReadBytes, elapsedSeconds),
            Rate(before.Disk.WrittenBytes, after.Disk.WrittenBytes, elapsedSeconds),
            rootDisk.Total,
            rootDisk.Used);
    }

    /// <summary>
    /// The mean of each field, stamped with the start of the period. Sizes are means as well, except
    /// the disk, which only grows or shrinks slowly: its last value says more.
    /// </summary>
    public static MetricsSample Average(IReadOnlyList<MetricsSample> samples, long periodStartUnixMs)
    {
        ArgumentNullException.ThrowIfNull(samples);
        if (samples.Count == 0)
        {
            throw new ArgumentException("An average needs at least one sample.", nameof(samples));
        }

        double Mean(Func<MetricsSample, double> field) => samples.Average(field);
        long MeanBytes(Func<MetricsSample, long> field) => (long)Math.Round(samples.Average(sample => (double)field(sample)));
        var last = samples[^1];
        return new MetricsSample(
            periodStartUnixMs,
            Mean(s => s.CpuPercent),
            Mean(s => s.CpuIowaitPercent),
            Mean(s => s.CpuStealPercent),
            Mean(s => s.Load1),
            Mean(s => s.Load5),
            Mean(s => s.Load15),
            MeanBytes(s => s.MemoryTotalBytes),
            MeanBytes(s => s.MemoryUsedBytes),
            MeanBytes(s => s.SwapTotalBytes),
            MeanBytes(s => s.SwapUsedBytes),
            Mean(s => s.NetworkReceiveBytesPerSecond),
            Mean(s => s.NetworkTransmitBytesPerSecond),
            Mean(s => s.DiskReadBytesPerSecond),
            Mean(s => s.DiskWriteBytesPerSecond),
            last.DiskTotalBytes,
            last.DiskUsedBytes);
    }

    /// <summary>Bytes per second. A counter that went backwards (a reboot, a driver reset) gives zero.</summary>
    private static double Rate(long before, long after, double elapsedSeconds) =>
        elapsedSeconds <= 0 || after < before ? 0 : (after - before) / elapsedSeconds;
}
