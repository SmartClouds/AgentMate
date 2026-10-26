using Tapper;

namespace Runova.ServerCore.Contracts;

// The server itself: what it is, what it runs, and how busy it is.

[TranspilationSource]
public enum OsFamily
{
    /// <summary>Ubuntu and Debian: apt, ufw, AppArmor.</summary>
    Debian,

    /// <summary>RHEL, Rocky, Alma and CentOS Stream: dnf, firewalld, SELinux.</summary>
    Rhel,

    Unknown,
}

/// <summary>From /etc/os-release, checked against the systems the core is built and tested for.</summary>
[TranspilationSource]
public sealed record OsInfo(
    string Id,
    string VersionId,
    string Name,
    OsFamily Family,
    bool Supported,
    string? UnsupportedReason = null);

[TranspilationSource]
public sealed record CpuInfo(string Model, int LogicalCores, int PhysicalCores, int Sockets);

/// <summary>A mounted filesystem. Pseudo filesystems, snaps and container layers are left out.</summary>
[TranspilationSource]
public sealed record DiskInfo(
    string MountPoint,
    string Device,
    string FileSystem,
    long TotalBytes,
    long UsedBytes,
    long AvailableBytes);

[TranspilationSource]
public sealed record NetworkInterfaceInfo(
    string Name,
    bool Up,
    string[] Addresses,
    string? MacAddress = null,
    long? SpeedMbps = null);

/// <summary>Whether the clock is kept in time, as timedatectl reports it; null where it could not tell.</summary>
[TranspilationSource]
public sealed record TimeSyncInfo(
    bool? Synchronized = null,
    bool? NtpEnabled = null,
    string? TimeZone = null,
    string? Service = null);

/// <summary>The facts the Overview shows. They change rarely, so the app asks for them, not a stream.</summary>
[TranspilationSource]
public sealed record SystemInfo(
    string Hostname,
    OsInfo Os,
    string Kernel,
    string Architecture,
    CpuInfo Cpu,
    long MemoryTotalBytes,
    long SwapTotalBytes,
    DiskInfo[] Disks,
    NetworkInterfaceInfo[] Networks,
    string[] PublicAddresses,
    long BootedAtUnixMs,
    TimeSyncInfo TimeSync,
    string[] RebootRequiredBy,
    long CollectedAtUnixMs,
    bool? RebootRequired = null);

[TranspilationSource]
public enum ServiceState
{
    Active,
    Reloading,
    Inactive,
    Failed,
    Activating,
    Deactivating,
    NotInstalled,
    Unknown,
}

/// <summary>The services a server panel cares about, as systemd sees them.</summary>
[TranspilationSource]
public sealed record ServiceInfo(
    string Name,
    string Unit,
    string Description,
    ServiceState State,
    string SubState,
    bool CanRestart,
    bool? EnabledAtBoot = null,
    long? ActiveSinceUnixMs = null,
    int? MainPid = null);

/// <summary>The services the app may restart. Anything else is refused.</summary>
[TranspilationSource]
public enum ManagedService
{
    Docker,
    Nginx,
}

/// <summary>
/// One reading. Live samples are single readings; history samples average a minute or a quarter
/// hour. Rates are per second; memory and disk sizes are bytes; disk is the root filesystem.
/// </summary>
[TranspilationSource]
public sealed record MetricsSample(
    long AtUnixMs,
    double CpuPercent,
    double CpuIowaitPercent,
    double CpuStealPercent,
    double Load1,
    double Load5,
    double Load15,
    long MemoryTotalBytes,
    long MemoryUsedBytes,
    long SwapTotalBytes,
    long SwapUsedBytes,
    double NetworkReceiveBytesPerSecond,
    double NetworkTransmitBytesPerSecond,
    double DiskReadBytesPerSecond,
    double DiskWriteBytesPerSecond,
    long DiskTotalBytes,
    long DiskUsedBytes);

[TranspilationSource]
public enum MetricsResolution
{
    /// <summary>Every reading of the last 15 minutes, from memory.</summary>
    Live,

    /// <summary>One-minute averages, kept 48 hours.</summary>
    Minute,

    /// <summary>Fifteen-minute averages, kept 30 days.</summary>
    QuarterHour,
}

/// <summary>
/// A live stream of readings. The interval is clamped to 1 to 60 seconds (5 by default). After a
/// reconnect, pass the time of the last sample received: readings since then are sent first, so
/// the chart has no gap and no repeats.
/// </summary>
[TranspilationSource]
public sealed record MetricsStreamRequest(int? IntervalMs = null, long? SinceUnixMs = null);

[TranspilationSource]
public sealed record MetricsHistoryRequest(MetricsResolution Resolution, long? FromUnixMs = null, long? ToUnixMs = null);

[TranspilationSource]
public sealed record MetricsHistory(MetricsResolution Resolution, int IntervalSeconds, MetricsSample[] Samples);
