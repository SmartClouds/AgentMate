using Tapper;

namespace Runova.ServerCore.Contracts;

// Compose stacks (E07), shown in the app as Apps. A stack is a named compose project; each
// upload of its files is a numbered revision, and a deploy runs one revision. Files arrive over
// REST (POST /api/v1/stacks/{id}/revisions, then PUT .../revisions/{n}/context for a build
// context), since a compose file and its .env can be larger than a hub message. Everything else
// is on the hub.

/// <summary>How a stack is doing, worked out from its containers and its last deploy.</summary>
[TranspilationSource]
public enum StackStatus
{
    /// <summary>Created, never deployed.</summary>
    New,

    /// <summary>A job is working on it right now.</summary>
    Busy,

    /// <summary>Every container runs, and none reports unhealthy.</summary>
    Running,

    /// <summary>Some containers run, others stopped or report unhealthy.</summary>
    Degraded,

    /// <summary>Its containers exist but none runs.</summary>
    Stopped,

    /// <summary>Deployed before, but no container is left (taken down).</summary>
    Down,

    /// <summary>The last deploy failed and nothing runs.</summary>
    Failed,
}

[TranspilationSource]
public enum StackRevisionState
{
    /// <summary>The files are in; the build context the upload announced has not arrived.</summary>
    AwaitingContext,

    /// <summary>Checked with docker compose config and ready to deploy.</summary>
    Ready,

    /// <summary>docker compose config refused it; Error says why.</summary>
    Invalid,

    Deploying,

    /// <summary>What runs now.</summary>
    Live,

    Failed,

    /// <summary>Ran once; a later revision took its place.</summary>
    Superseded,
}

[TranspilationSource]
public enum StackStepKind
{
    Validate,
    Pull,
    Build,
    Up,
    Health,
}

[TranspilationSource]
public enum StackStepState
{
    Pending,
    Running,
    Succeeded,
    Failed,
    Skipped,
    Cancelled,
}

[TranspilationSource]
public enum StackRiskSeverity
{
    Critical,
    High,
    Medium,
    Low,
}

[TranspilationSource]
public enum StackAction
{
    Start,
    Stop,
    Restart,

    /// <summary>docker compose down: the containers and networks go, volumes stay.</summary>
    Down,
}

/// <summary>Where the app took the files from, so it can deploy again from the same place.</summary>
[TranspilationSource]
public sealed record StackSource(
    string? ProjectId = null,
    string? ProjectName = null,
    string? ComposePath = null,
    string? EnvironmentId = null,
    string? EnvironmentName = null);

[TranspilationSource]
public sealed record StackInfo(
    Guid Id,
    string Name,
    StackStatus Status,
    long CreatedAtUnixMs,
    long UpdatedAtUnixMs,
    int RevisionCount,
    int? LiveRevision = null,
    string? Description = null,
    StackSource? Source = null,
    int RunningContainers = 0,
    int Containers = 0,
    Guid? ActiveJobId = null);

/// <summary>
/// A risk the core found in the compose file as docker compose config resolved it. Ids follow the
/// app's linter (rule:service:subject), so an acknowledgment given there counts here.
/// </summary>
[TranspilationSource]
public sealed record StackRisk(string Id, string Rule, StackRiskSeverity Severity, string Message, string? Service = null);

/// <summary>One step of a deploy, with the job log lines it wrote (FirstLogSeq to LastLogSeq).</summary>
[TranspilationSource]
public sealed record StackDeployStep(
    StackStepKind Kind,
    StackStepState State,
    long? StartedAtUnixMs = null,
    long? FinishedAtUnixMs = null,
    long? FirstLogSeq = null,
    long? LastLogSeq = null,
    string? Detail = null);

/// <summary>A published port as the deploy binds it (after the loopback override).</summary>
[TranspilationSource]
public sealed record StackPortBinding(string Service, int Target, string Protocol, string? HostIp = null, string? Published = null);

[TranspilationSource]
public sealed record StackRevisionInfo(
    Guid StackId,
    int Number,
    StackRevisionState State,
    long CreatedAtUnixMs,
    string ComposeSha256,
    string[] EnvKeys,
    string[] Services,
    string[] ProxiedServices,
    bool HasBuildContext,
    StackDeployStep[] Steps,
    StackRisk[] Findings,
    string[] AcknowledgedRisks,
    string[] UnacknowledgedRisks,
    StackPortBinding[] Bindings,
    string? CreatedBy = null,
    Guid? JobId = null,
    long? DeployedAtUnixMs = null,
    long? FinishedAtUnixMs = null,
    int? RollbackOf = null,
    string? Error = null,
    StackSource? Source = null);

[TranspilationSource]
public sealed record StackServiceInfo(string Name, ContainerSummary[] Containers, StackPortBinding[] Ports, string? Image = null);

[TranspilationSource]
public sealed record StackDetails(StackInfo Stack, StackRevisionInfo[] Revisions, StackServiceInfo[] Services);

/// <summary>A revision's files as uploaded (never interpolated) and the override the core wrote. Env values never leave the core.</summary>
[TranspilationSource]
public sealed record StackRevisionFiles(int Number, string Compose, string[] EnvKeys, string? Override = null);

[TranspilationSource]
public sealed record CreateStackRequest(string Name, string? Description = null, StackSource? Source = null);

[TranspilationSource]
public sealed record StackRevisionRef(Guid StackId, int Revision);

[TranspilationSource]
public sealed record AcknowledgeStackRisksRequest(Guid StackId, int Revision, string[] RiskIds);

[TranspilationSource]
public sealed record StackActionRequest(Guid StackId, StackAction Action);

/// <summary>
/// The body of POST /api/v1/stacks/{id}/revisions. Env is the rendered .env text (stored 0600,
/// never shown again); ProxiedServices publish on 127.0.0.1 only. BuildContext announces a
/// .tar.gz that follows with PUT .../revisions/{n}/context.
/// </summary>
[TranspilationSource]
public sealed record StackRevisionUpload(
    string Compose,
    string Env,
    string[] ProxiedServices,
    string[] AcknowledgedRisks,
    bool BuildContext = false,
    StackSource? Source = null);

/// <summary>Why a revision was made from another one on the server, for the audit trail.</summary>
[TranspilationSource]
public enum StackRevisionPurpose
{
    /// <summary>Anything else: the same files with other proxied services.</summary>
    Edit,

    /// <summary>Services that published beyond 127.0.0.1 move to loopback (E13).</summary>
    MakePrivate,

    /// <summary>An App Store app on newer images: a new compose file, the same .env (E12).</summary>
    Update,
}

/// <summary>
/// A new revision copied from Revision on the server, its .env and project files included, so
/// no env value travels. Compose replaces the compose file when set (an App Store update);
/// ProxiedServices replaces the loopback set; AcknowledgedRisks defaults to the source's.
/// The revision is validated like an upload and deployed with DeployStack.
/// </summary>
[TranspilationSource]
public sealed record ReviseStackRequest(
    Guid StackId,
    int Revision,
    string[] ProxiedServices,
    string? Compose = null,
    string[]? AcknowledgedRisks = null,
    StackRevisionPurpose Purpose = StackRevisionPurpose.Edit);

/// <summary>One entry of a revision's .env. Only RevealStackEnv returns these (Admin, step-up).</summary>
[TranspilationSource]
public sealed record StackEnvEntry(string Key, string Value);

/// <summary>What a refused upload answers with (status 400, 404 or 409).</summary>
[TranspilationSource]
public sealed record StackUploadError(string Message);
