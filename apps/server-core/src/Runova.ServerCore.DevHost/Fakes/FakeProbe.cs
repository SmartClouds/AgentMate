using Runova.ServerCore.Contracts;
using Runova.ServerCore.Platform;

namespace Runova.ServerCore.DevHost.Fakes;

/// <summary>
/// Counters that move like a lightly loaded web server's: CPU and traffic follow slow waves with
/// a little noise, memory drifts, and the counters only ever grow, as the kernel's do.
/// RUNOVA_DEV_DISK_USED_PERCENT fills the root filesystem, to try the disk pressure alert.
/// </summary>
internal sealed class FakeProbe(TimeProvider time) : ISystemProbe
{
    private const long Gigabyte = 1024L * 1024 * 1024;

    private readonly Lock _gate = new();
    private readonly Random _noise = new(7);
    private readonly long _started = time.GetTimestamp();
    private long _lastTimestamp = time.GetTimestamp();
    private double _busy;
    private double _idle;
    private double _received;
    private double _transmitted;
    private double _read;
    private double _written;

    public SystemCounters ReadCounters()
    {
        lock (_gate)
        {
            var now = time.GetTimestamp();
            var seconds = time.GetElapsedTime(_lastTimestamp, now).TotalSeconds;
            _lastTimestamp = now;
            var t = time.GetElapsedTime(_started, now).TotalSeconds;

            // Four cores at 100 ticks a second each.
            var load = Math.Clamp(0.22 + 0.14 * Math.Sin(t / 45) + 0.05 * _noise.NextDouble(), 0.02, 0.95);
            _busy += seconds * 400 * load;
            _idle += seconds * 400 * (1 - load);
            _received += seconds * (180_000 + 120_000 * Math.Sin(t / 30) + 40_000 * _noise.NextDouble());
            _transmitted += seconds * (90_000 + 70_000 * Math.Sin(t / 25 + 1) + 20_000 * _noise.NextDouble());
            _read += seconds * (40_000 + 35_000 * Math.Max(0, Math.Sin(t / 20)));
            _written += seconds * (120_000 + 100_000 * Math.Max(0, Math.Sin(t / 35 + 2)));
            var used = (long)((2.6 + 0.4 * Math.Sin(t / 120)) * Gigabyte);

            return new SystemCounters(
                new CpuTimes((long)_busy, 0, 0, (long)_idle, 0, 0, 0, 0),
                new MemoryReading(8 * Gigabyte, 8 * Gigabyte - used, 2 * Gigabyte, 2 * Gigabyte - 128 * 1024 * 1024),
                new NetworkCounters((long)_received, (long)_transmitted),
                new DiskCounters((long)_read, (long)_written),
                new LoadAverage(Math.Round(load * 4, 2), Math.Round(load * 3.6, 2), Math.Round(load * 3.2, 2)));
        }
    }

    public IReadOnlyList<DiskInfo> ReadFilesystems()
    {
        var percent = double.TryParse(
            Environment.GetEnvironmentVariable("RUNOVA_DEV_DISK_USED_PERCENT"),
            System.Globalization.CultureInfo.InvariantCulture,
            out var chosen) ? Math.Clamp(chosen, 0, 100) : 46;
        var total = 80 * Gigabyte;
        var used = (long)(total * percent / 100);
        return
        [
            new DiskInfo("/", "/dev/sda1", "ext4", total, used, total - used),
            new DiskInfo("/boot", "/dev/sda16", "ext4", 881 * 1024 * 1024, 190 * 1024 * 1024, 630 * 1024 * 1024),
            new DiskInfo("/boot/efi", "/dev/sda15", "vfat", 105 * 1024 * 1024, 6 * 1024 * 1024, 99 * 1024 * 1024),
        ];
    }
}
