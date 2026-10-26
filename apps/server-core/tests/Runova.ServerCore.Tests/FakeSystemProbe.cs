using Runova.ServerCore.Contracts;
using Runova.ServerCore.Platform;

namespace Runova.ServerCore.Tests;

/// <summary>Counters and filesystems a test sets; each read returns the current ones.</summary>
internal sealed class FakeSystemProbe : ISystemProbe
{
    private readonly Lock _gate = new();
    private SystemCounters _counters = Counters(cpuBusy: 0, cpuIdle: 0);
    private IReadOnlyList<DiskInfo> _filesystems = [Disk("/", used: 40, total: 100)];

    public int Reads { get; private set; }

    public static SystemCounters Counters(
        long cpuBusy,
        long cpuIdle,
        long received = 0,
        long transmitted = 0,
        long read = 0,
        long written = 0,
        long memoryUsed = 2_000_000_000) =>
        new(
            new CpuTimes(User: cpuBusy, Nice: 0, System: 0, Idle: cpuIdle, Iowait: 0, Irq: 0, SoftIrq: 0, Steal: 0),
            new MemoryReading(TotalBytes: 8_000_000_000, AvailableBytes: 8_000_000_000 - memoryUsed, SwapTotalBytes: 1_000_000_000, SwapFreeBytes: 900_000_000),
            new NetworkCounters(received, transmitted),
            new DiskCounters(read, written),
            new LoadAverage(0.5, 0.4, 0.3));

    public static DiskInfo Disk(string mountPoint, long used, long total) =>
        new(mountPoint, "/dev/sda1", "ext4", total, used, total - used);

    public void Set(SystemCounters counters)
    {
        lock (_gate)
        {
            _counters = counters;
        }
    }

    public void SetFilesystems(params DiskInfo[] filesystems)
    {
        lock (_gate)
        {
            _filesystems = filesystems;
        }
    }

    public SystemCounters ReadCounters()
    {
        lock (_gate)
        {
            Reads++;
            return _counters;
        }
    }

    public IReadOnlyList<DiskInfo> ReadFilesystems()
    {
        lock (_gate)
        {
            return _filesystems;
        }
    }
}
