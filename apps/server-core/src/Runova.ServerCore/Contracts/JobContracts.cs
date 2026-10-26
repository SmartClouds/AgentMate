using Tapper;

namespace Runova.ServerCore.Contracts;

// Long-running work (package upgrades, reboots, restarts) runs as a job: it has a state, a log
// kept on the server, and a stream the app can leave and pick up again.

[TranspilationSource]
public enum JobKind
{
    PackagesRefresh,
    PackagesUpgrade,
    PackagesUpgradeSecurity,
    AutomaticUpdates,
    Reboot,
    ServiceRestart,
    DockerInstall,
    ImagePull,
    NginxInstall,
    CertificateIssue,
    CertificateRenew,
    StackDeploy,
    StackAction,
    StackDelete,
}

[TranspilationSource]
public enum JobState
{
    Running,
    Succeeded,
    Failed,
    Cancelled,

    /// <summary>The core stopped while the job ran. The work itself may have finished anyway.</summary>
    Interrupted,
}

[TranspilationSource]
public enum JobLogSource
{
    Out,
    Err,

    /// <summary>A note from the core itself: a step starting, a result, a warning.</summary>
    System,
}

[TranspilationSource]
public sealed record JobInfo(
    Guid Id,
    JobKind Kind,
    string Title,
    JobState State,
    long CreatedAtUnixMs,
    long LogLines,
    bool Cancellable,
    string? Resource = null,
    string? RequestedBy = null,
    long? FinishedAtUnixMs = null,
    int? ExitCode = null,
    string? Error = null);

/// <summary>A log line, numbered from 1. Text is redacted before it is stored or sent.</summary>
[TranspilationSource]
public sealed record JobLogLine(long Seq, long AtUnixMs, JobLogSource Source, string Text);

/// <summary>
/// One message of a job stream: log lines in order, and the job's state when it changed. The first
/// message always carries the job; the last carries its final state, then the stream completes.
/// </summary>
[TranspilationSource]
public sealed record JobStreamItem(JobLogLine[] Lines, JobInfo? Job = null);

/// <summary>Newest first, a page at a time.</summary>
[TranspilationSource]
public sealed record JobQuery(int? Limit = null, long? BeforeCreatedAtUnixMs = null, bool ActiveOnly = false);

[TranspilationSource]
public sealed record JobPage(JobInfo[] Jobs, long? NextBeforeCreatedAtUnixMs = null);
