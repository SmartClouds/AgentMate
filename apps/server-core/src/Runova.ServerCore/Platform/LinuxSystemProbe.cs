using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.Platform;

/// <summary>Counters from /proc and filesystem sizes from statvfs. Cheap enough to read every second.</summary>
internal sealed class LinuxSystemProbe(ISystemFiles files, IFileSystemStats stats) : ISystemProbe
{
    public SystemCounters ReadCounters() => new(
        ProcParsers.ParseCpuTimes(Read("/proc/stat")),
        ProcParsers.ParseMemory(Read("/proc/meminfo")),
        ProcParsers.ParseNetwork(files.ReadText("/proc/net/dev") ?? string.Empty),
        ProcParsers.ParseDisks(files.ReadText("/proc/diskstats") ?? string.Empty),
        ProcParsers.ParseLoad(Read("/proc/loadavg")));

    /// <summary>Filesystems whose size could be read; a stale network mount is left out rather than waited on.</summary>
    public IReadOnlyList<DiskInfo> ReadFilesystems()
    {
        var disks = new List<DiskInfo>();
        foreach (var mount in ProcParsers.ParseMounts(files.ReadText("/proc/mounts") ?? string.Empty))
        {
            if (stats.Of(mount.MountPoint) is { Total: > 0 } size)
            {
                disks.Add(new DiskInfo(
                    mount.MountPoint,
                    mount.Device,
                    mount.FileSystem,
                    size.Total,
                    Math.Max(0, size.Total - size.Free),
                    size.Available));
            }
        }

        return disks;
    }

    private string Read(string path) =>
        files.ReadText(path) ?? throw new InvalidOperationException($"{path} could not be read.");
}
