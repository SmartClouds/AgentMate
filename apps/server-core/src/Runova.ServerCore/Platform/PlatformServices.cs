using Runova.ServerCore.Contracts;
using Runova.ServerCore.Jobs;

namespace Runova.ServerCore.Platform;

// The seams between the core and the machine it runs on. The core uses the Linux implementations;
// the DevHost (never published) and the tests put fakes in their place, so the whole API can be
// exercised on Windows and macOS.

/// <summary>Files read from the system: /proc, /etc, /run. Rooted, so fixtures can stand in for a server.</summary>
internal interface ISystemFiles
{
    /// <summary>The file's text, or null when it is missing or cannot be read.</summary>
    string? ReadText(string path);

    bool Exists(string path);

    /// <summary>Replaces the file in one step (a temporary file renamed over it).</summary>
    void WriteText(string path, string content, UnixFileMode mode);
}

internal sealed class SystemFiles(string root = "/") : ISystemFiles
{
    public string? ReadText(string path)
    {
        try
        {
            return File.ReadAllText(Map(path));
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    public bool Exists(string path) => File.Exists(Map(path)) || Directory.Exists(Map(path));

    public void WriteText(string path, string content, UnixFileMode mode)
    {
        ArgumentNullException.ThrowIfNull(content);
        var target = Map(path);
        var temporary = $"{target}.runova-{Guid.NewGuid():N}";
        File.WriteAllText(temporary, content);
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(temporary, mode);
        }

        File.Move(temporary, target, overwrite: true);
    }

    private string Map(string path)
    {
        ArgumentNullException.ThrowIfNull(path);
        if (!path.StartsWith('/') || path.Split('/').Contains(".."))
        {
            throw new ArgumentException("System paths are absolute, without '..'.", nameof(path));
        }

        return root == "/" ? path : Path.Combine(root, path[1..].Replace('/', Path.DirectorySeparatorChar));
    }
}

/// <summary>Sizes of a mounted filesystem (statvfs).</summary>
internal interface IFileSystemStats
{
    (long Total, long Free, long Available)? Of(string mountPoint);
}

internal sealed class DriveStats : IFileSystemStats
{
    public (long Total, long Free, long Available)? Of(string mountPoint)
    {
        try
        {
            var drive = new DriveInfo(mountPoint);
            return (drive.TotalSize, drive.TotalFreeSpace, drive.AvailableFreeSpace);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException)
        {
            return null;
        }
    }
}

/// <summary>Counters since boot, read together so rates come from one moment.</summary>
internal sealed record SystemCounters(
    CpuTimes Cpu,
    MemoryReading Memory,
    NetworkCounters Network,
    DiskCounters Disk,
    LoadAverage Load);

/// <summary>What the metrics sampler and the alert monitor read, many times a minute.</summary>
internal interface ISystemProbe
{
    SystemCounters ReadCounters();

    IReadOnlyList<DiskInfo> ReadFilesystems();
}

/// <summary>The Overview's facts, gathered on demand and kept briefly.</summary>
internal interface ISystemInfoSource
{
    Task<SystemInfo> GetAsync(CancellationToken cancellationToken);
}

/// <summary>Services through systemd.</summary>
internal interface IServiceManager
{
    Task<IReadOnlyList<ServiceInfo>> ListAsync(CancellationToken cancellationToken);

    /// <summary>Restarts a managed service that is installed; the job's log shows what happened.</summary>
    Task RestartAsync(ManagedService service, JobContext job, CancellationToken cancellationToken);
}

/// <summary>Whether the running kernel or libraries are older than what is installed.</summary>
internal sealed record RebootStatus(bool? Required, IReadOnlyList<string> Packages);

/// <summary>apt on the Debian family, dnf on the RHEL family.</summary>
internal interface IPackageManager
{
    /// <summary>"apt", "dnf", or "none" where the core knows no package manager.</summary>
    string Name { get; }

    /// <summary>From the local package index; read-only, but dnf may fetch expired metadata first.</summary>
    Task<IReadOnlyList<UpgradablePackage>> ListUpgradableAsync(CancellationToken cancellationToken);

    /// <summary>apt-get update or dnf makecache, in a transient unit.</summary>
    Task RefreshIndexAsync(JobContext job, CancellationToken cancellationToken);

    /// <summary>Refreshes the index, then upgrades everything or only security fixes, in transient units.</summary>
    Task UpgradeAsync(bool securityOnly, JobContext job, CancellationToken cancellationToken);

    Task<AutoUpdatesInfo> GetAutomaticUpdatesAsync(CancellationToken cancellationToken);

    /// <summary>Installs the tool when needed and turns automatic security updates on or off.</summary>
    Task SetAutomaticUpdatesAsync(bool enabled, JobContext job, CancellationToken cancellationToken);

    Task<RebootStatus> GetRebootStatusAsync(CancellationToken cancellationToken);
}

/// <summary>Reboots the server.</summary>
internal interface IPowerControl
{
    /// <summary>
    /// Schedules the reboot and returns: it happens after <paramref name="delay"/> from a transient
    /// timer, so the job has time to record its success and the app time to hear it.
    /// </summary>
    Task ScheduleRebootAsync(JobContext job, TimeSpan delay, CancellationToken cancellationToken);
}
