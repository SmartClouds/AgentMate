using Tapper;

namespace Runova.ServerCore.Contracts;

// Docker on the server: the engine, its containers (grouped by compose project), their live
// figures, logs and consoles, and the images, volumes and networks around them. Environment
// values never travel in these types; only their names do.

/// <summary>
/// The engine as the core finds it. Packages that conflict with Docker's own (podman, runc, the
/// distribution's docker.io) are listed so the app can ask before an install removes them.
/// </summary>
[TranspilationSource]
public sealed record DockerStatus(
    bool Installed,
    bool Running,
    bool ComposeSupported,
    string[] ConflictingPackages,
    string? EngineVersion = null,
    string? ApiVersion = null,
    string? ComposeVersion = null,
    string? StorageDriver = null,
    int? CgroupVersion = null,
    string? Message = null);

/// <summary>Removing conflicting packages only happens when this says so; the app asks first.</summary>
[TranspilationSource]
public sealed record DockerInstallRequest(bool RemoveConflictingPackages = false);

[TranspilationSource]
public enum ContainerState
{
    Created,
    Running,
    Paused,
    Restarting,
    Removing,
    Exited,
    Dead,
    Unknown,
}

[TranspilationSource]
public enum ContainerHealth
{
    /// <summary>The image has no health check.</summary>
    None,
    Starting,
    Healthy,
    Unhealthy,
}

/// <summary>A published port. Without a host port the container port is only reachable inside Docker.</summary>
[TranspilationSource]
public sealed record ContainerPort(int PrivatePort, string Protocol, string? HostIp = null, int? HostPort = null);

[TranspilationSource]
public sealed record ContainerSummary(
    string Id,
    string Name,
    string Image,
    string ImageId,
    ContainerState State,
    string Status,
    ContainerHealth Health,
    long CreatedAtUnixMs,
    ContainerPort[] Ports,
    string? ComposeProject = null,
    string? ComposeService = null,
    int? ComposeNumber = null);

/// <summary>A compose project's containers, or (with no project) the ones started on their own.</summary>
[TranspilationSource]
public sealed record ContainerGroup(string? Project, ContainerSummary[] Containers, string? WorkingDirectory = null);

/// <summary>Compose projects by name, then the standalone containers last.</summary>
[TranspilationSource]
public sealed record ContainerList(ContainerGroup[] Groups);

[TranspilationSource]
public sealed record ContainerLabel(string Name, string Value);

[TranspilationSource]
public sealed record ContainerMount(string Type, string Destination, bool ReadWrite, string? Source = null, string? Name = null);

[TranspilationSource]
public sealed record ContainerNetwork(string Network, string? IpAddress = null, string? Ipv6Address = null, string? MacAddress = null);

/// <summary>
/// One container in full, except its environment values: only the variable names are here.
/// Labels pass through the redactor, seeded with the container's own values.
/// </summary>
[TranspilationSource]
public sealed record ContainerDetails(
    ContainerSummary Summary,
    string[] Command,
    string[] Entrypoint,
    string[] EnvKeys,
    ContainerLabel[] Labels,
    ContainerMount[] Mounts,
    ContainerNetwork[] Networks,
    string RestartPolicy,
    int RestartCount,
    bool Tty,
    bool Privileged,
    bool OomKilled,
    string? User = null,
    string? WorkingDirectory = null,
    string? Hostname = null,
    long? StartedAtUnixMs = null,
    long? FinishedAtUnixMs = null,
    int? ExitCode = null,
    string? Error = null,
    long? MemoryLimitBytes = null,
    double? CpuLimit = null);

/// <summary>An environment variable with its value. Only RevealContainerEnv returns these.</summary>
[TranspilationSource]
public sealed record ContainerEnvVariable(string Name, string Value);

/// <summary>Removing with volumes is an explicit choice (Admin only); the app asks for a typed confirmation first.</summary>
[TranspilationSource]
public sealed record ContainerRemoveRequest(string ContainerId, bool RemoveVolumes = false, bool Force = false);

/// <summary>
/// Live figures for some containers, or for every running one when no ids are given. Samples
/// come at least the interval apart (clamped to 1 to 60 seconds, 2 by default). There is nothing
/// to resume: after a reconnect, open the stream again.
/// </summary>
[TranspilationSource]
public sealed record ContainerStatsRequest(string[]? ContainerIds = null, int? IntervalMs = null);

/// <summary>
/// The figures `docker stats` shows, computed the same way: CPU from the deltas against the
/// previous reading, memory without the inactive page cache, network and block IO as totals.
/// </summary>
[TranspilationSource]
public sealed record ContainerStatsSample(
    string ContainerId,
    long AtUnixMs,
    double CpuPercent,
    int OnlineCpus,
    long MemoryUsedBytes,
    long MemoryLimitBytes,
    double MemoryPercent,
    long NetworkReceivedBytes,
    long NetworkTransmittedBytes,
    long BlockReadBytes,
    long BlockWrittenBytes,
    long Pids);

/// <summary>The newest sample of each container since the last batch, and the ones that stopped.</summary>
[TranspilationSource]
public sealed record ContainerStatsBatch(long AtUnixMs, ContainerStatsSample[] Samples, string[] Stopped);

[TranspilationSource]
public enum ContainerLogSource
{
    Stdout,
    Stderr,
}

/// <summary>
/// The last Tail lines (200 by default, at most 5000; 0 for none), or those since a time, then new
/// ones while Follow is on. After a reconnect pass the last line's Timestamp as AfterTimestamp:
/// the stream carries on right after it, without a gap or a repeat.
/// </summary>
[TranspilationSource]
public sealed record ContainerLogsRequest(
    string ContainerId,
    int? Tail = null,
    long? SinceUnixMs = null,
    string? AfterTimestamp = null,
    bool Follow = true);

/// <summary>A log line, redacted. Timestamp is Docker's own (RFC 3339, nanoseconds), the resume point.</summary>
[TranspilationSource]
public sealed record ContainerLogLine(ContainerLogSource Stream, string Timestamp, long AtUnixMs, string Text);

[TranspilationSource]
public sealed record ContainerLogBatch(ContainerLogLine[] Lines);

/// <summary>A shell in the container (bash when it has one, else sh) unless Command says otherwise.</summary>
[TranspilationSource]
public sealed record ConsoleRequest(string ContainerId, int Columns, int Rows, string[]? Command = null, string? User = null);

/// <summary>Keystrokes, a new terminal size, or both.</summary>
[TranspilationSource]
public sealed record ConsoleInput(string? Data = null, int? Columns = null, int? Rows = null);

/// <summary>What the terminal shows. The last message has Ended set, with the exit code when known.</summary>
[TranspilationSource]
public sealed record ConsoleOutput(string? Data = null, bool Ended = false, int? ExitCode = null);

[TranspilationSource]
public sealed record ImageInfo(
    string Id,
    string[] Tags,
    string[] Digests,
    long CreatedAtUnixMs,
    long SizeBytes,
    int Containers);

/// <summary>
/// An image reference such as nginx, nginx:1.29 or ghcr.io/org/app@sha256:... (latest when no tag).
/// Auth, when the app sends one, signs in to the image's registry for this pull only (E08); without
/// it the credential stored on the server for that registry is used, if there is one.
/// </summary>
[TranspilationSource]
public sealed record ImagePullRequest(string Reference, RegistryAuth? Auth = null);

[TranspilationSource]
public sealed record ImageRemoveRequest(string Image, bool Force = false);

[TranspilationSource]
public sealed record VolumeInfo(
    string Name,
    string Driver,
    string Mountpoint,
    int Containers,
    long? CreatedAtUnixMs = null,
    long? SizeBytes = null,
    string? ComposeProject = null);

[TranspilationSource]
public sealed record NetworkInfo(
    string Id,
    string Name,
    string Driver,
    string Scope,
    bool Internal,
    bool BuiltIn,
    string[] Subnets,
    int Containers,
    string? ComposeProject = null);

[TranspilationSource]
public sealed record DockerDiskUsageEntry(int Count, int Active, long SizeBytes, long ReclaimableBytes);

/// <summary>`docker system df`.</summary>
[TranspilationSource]
public sealed record DockerDiskUsage(
    DockerDiskUsageEntry Images,
    DockerDiskUsageEntry Containers,
    DockerDiskUsageEntry Volumes,
    DockerDiskUsageEntry BuildCache);

[TranspilationSource]
public enum DockerPruneTarget
{
    /// <summary>Stopped containers.</summary>
    Containers,

    /// <summary>Dangling images, or every unused one with AllImages.</summary>
    Images,

    /// <summary>Unused anonymous volumes.</summary>
    Volumes,

    /// <summary>Unused networks.</summary>
    Networks,

    /// <summary>Containers, networks, images and the build cache; volumes too with IncludeVolumes.</summary>
    System,

    /// <summary>All of the build cache, in use or not.</summary>
    BuildCache,
}

[TranspilationSource]
public sealed record DockerPruneRequest(DockerPruneTarget Target, bool AllImages = false, bool IncludeVolumes = false);

[TranspilationSource]
public sealed record DockerPruneResult(int Removed, long ReclaimedBytes);

/// <summary>
/// Engine events as they happen. After a reconnect pass the last event's Cursor: the stream
/// carries on right after it.
/// </summary>
[TranspilationSource]
public sealed record DockerEventsRequest(long? SinceUnixMs = null, string? AfterCursor = null);

/// <summary>
/// One engine event (a container started, an image was pulled, a volume removed). Only a few
/// well-known attributes are passed on; labels and the rest stay on the server.
/// </summary>
[TranspilationSource]
public sealed record DockerEvent(
    string Type,
    string Action,
    string ActorId,
    long AtUnixMs,
    string Cursor,
    string? Name = null,
    string? Image = null,
    string? ComposeProject = null,
    string? ComposeService = null,
    int? ExitCode = null);
