using Tapper;

namespace Runova.ServerCore.Contracts;

// The host firewall: ufw on the Debian family, firewalld on the RHEL family. Every change goes
// through a change set: the core checks it cannot cut this computer's SSH off, saves the current
// rules, applies the change and arms a systemd timer that puts the saved rules back after a minute
// unless the change is confirmed over a new SSH connection.

[TranspilationSource]
public enum FirewallBackendKind
{
    /// <summary>Neither ufw nor firewalld is installed.</summary>
    None,
    Ufw,
    Firewalld,
}

[TranspilationSource]
public enum FirewallAction
{
    Allow,

    /// <summary>Dropped without an answer.</summary>
    Deny,

    /// <summary>Refused with an answer, so the other side knows at once.</summary>
    Reject,

    /// <summary>ufw only: allowed, but an address opening six connections in 30 seconds is refused.</summary>
    Limit,
}

[TranspilationSource]
public enum FirewallProtocol
{
    /// <summary>TCP and UDP (and, for a rule without a port, every protocol).</summary>
    Any,
    Tcp,
    Udp,
}

[TranspilationSource]
public enum FirewallPolicy
{
    Allow,
    Deny,
    Reject,
}

[TranspilationSource]
public enum FirewallFamilies
{
    Both,
    Ipv4,
    Ipv6,
}

/// <summary>
/// A rule as the app adds it. Without a port it covers every port, and then it needs a source.
/// PortTo makes a range (which needs TCP or UDP). Source is an address or a network in CIDR form.
/// </summary>
[TranspilationSource]
public sealed record FirewallRuleSpec(
    FirewallAction Action,
    FirewallProtocol Protocol,
    int? Port = null,
    int? PortTo = null,
    string? Source = null,
    string? Comment = null);

/// <summary>
/// A rule as the firewall holds it, in the order it is checked. Rules made outside Runova in a
/// form it cannot change are listed too, not editable, with a note saying why.
/// </summary>
[TranspilationSource]
public sealed record FirewallRuleInfo(
    string Id,
    FirewallAction Action,
    FirewallProtocol Protocol,
    FirewallFamilies Families,
    string Description,
    bool Editable,
    int? Port = null,
    int? PortTo = null,
    string? Source = null,
    string? Comment = null,
    string? Service = null,
    string? Interface = null,
    string? Destination = null,
    bool Outgoing = false,
    string? Note = null);

/// <summary>The ports sshd listens on (from `sshd -T`); Error says why they are unknown.</summary>
[TranspilationSource]
public sealed record SshPortsInfo(int[] Ports, string? Error = null);

[TranspilationSource]
public sealed record FirewallStatus(
    FirewallBackendKind Backend,
    bool Installed,
    bool Active,
    FirewallPolicy DefaultIncoming,
    FirewallPolicy DefaultOutgoing,
    bool Ipv6,
    FirewallRuleInfo[] Rules,
    string[] Warnings,
    SshPortsInfo Ssh,
    int ConfirmWithinSeconds,
    long CheckedAtUnixMs,
    string? Zone = null,
    FirewallChangeSetInfo? Pending = null,
    string? Error = null);

/// <summary>Rules for a common service. SuggestSource: open it to the addresses that need it only.</summary>
[TranspilationSource]
public sealed record FirewallPreset(
    string Id,
    string Name,
    string Description,
    FirewallRuleSpec[] Rules,
    bool SuggestSource);

[TranspilationSource]
public enum FirewallChangeKind
{
    AddRule,
    RemoveRule,
    SetDefaultIncoming,

    /// <summary>Needs a step-up.</summary>
    Enable,

    /// <summary>Needs a step-up.</summary>
    Disable,
}

[TranspilationSource]
public sealed record FirewallChange(
    FirewallChangeKind Kind,
    FirewallRuleSpec? Rule = null,
    string? RuleId = null,
    FirewallPolicy? Policy = null);

/// <summary>
/// SshConnection is `$SSH_CONNECTION` as an exec on the app's SSH connection prints it (client
/// address, client port, server address, server port); the core also works it out itself.
/// OverrideConfirmation is the phrase the lockout guard asked for, typed by the person; with it
/// (and a step-up) a change that would block SSH goes ahead anyway.
/// </summary>
[TranspilationSource]
public sealed record FirewallChangeRequest(
    FirewallChange[] Changes,
    string? SshConnection = null,
    string? OverrideConfirmation = null);

/// <summary>
/// Whether a change would cut this computer's SSH off. Checked lists every address and port it
/// tried and the outcome; when Blocked, ConfirmationPhrase is what the person types to go ahead.
/// </summary>
[TranspilationSource]
public sealed record FirewallGuardVerdict(
    bool Blocked,
    string[] Reasons,
    string[] Checked,
    string? ConfirmationPhrase = null);

/// <summary>What a change set would do, without doing it: the exact commands and the guard's verdict.</summary>
[TranspilationSource]
public sealed record FirewallChangePreview(
    string Summary,
    string[] Commands,
    string[] Notes,
    FirewallRuleInfo[] ResultingRules,
    bool ResultingActive,
    FirewallPolicy ResultingDefaultIncoming,
    FirewallGuardVerdict Guard,
    bool NeedsStepUp,
    int ConfirmWithinSeconds);

[TranspilationSource]
public enum FirewallChangeState
{
    /// <summary>The rules were saved and the rollback timer armed; the change is being made.</summary>
    Applying,

    /// <summary>Applied. Rolled back at the deadline unless confirmed over a new SSH connection.</summary>
    AwaitingConfirmation,

    Confirmed,

    RolledBack,

    /// <summary>Putting the saved rules back failed: the server needs a look from its console.</summary>
    RollbackFailed,

    /// <summary>Nothing was changed: the rollback timer could not be armed.</summary>
    Failed,
}

[TranspilationSource]
public enum FirewallRollbackCause
{
    /// <summary>Nobody confirmed in time.</summary>
    Timer,

    /// <summary>Someone reverted it by hand.</summary>
    User,

    /// <summary>A step of the change failed, so the rest was undone at once.</summary>
    ApplyFailed,

    /// <summary>The server restarted before it was confirmed (transient timers do not survive that).</summary>
    Restart,
}

[TranspilationSource]
public sealed record FirewallChangeSetInfo(
    Guid Id,
    FirewallChangeState State,
    FirewallBackendKind Backend,
    string Summary,
    string[] Commands,
    long CreatedAtUnixMs,
    bool GuardOverridden,
    long? DeadlineUnixMs = null,
    long? FinishedAtUnixMs = null,
    string? RequestedBy = null,
    string? AppliedFrom = null,
    FirewallRollbackCause? RolledBackBy = null,
    string? Error = null);

/// <summary>Newest first.</summary>
[TranspilationSource]
public sealed record FirewallChangeSetQuery(int? Limit = null);

/// <summary>Who can reach a listening port, by the address it is bound to.</summary>
[TranspilationSource]
public enum ExposureScope
{
    /// <summary>Loopback: this server only.</summary>
    Local,

    /// <summary>A private, link-local or unique-local address: the local network.</summary>
    Private,

    /// <summary>Every address (0.0.0.0, ::, *) or a public one.</summary>
    Public,
}

/// <summary>What the firewall makes of a port that is reachable by its address.</summary>
[TranspilationSource]
public enum ExposureFirewall
{
    /// <summary>The firewall is off, so nothing stands in the way.</summary>
    Off,

    /// <summary>Allowed from anywhere.</summary>
    Open,

    /// <summary>Allowed from some addresses only.</summary>
    Restricted,

    Closed,

    /// <summary>Published by Docker, which sends the traffic past the host firewall.</summary>
    Bypassed,

    /// <summary>Not reachable from outside anyway (a loopback address).</summary>
    NotApplicable,
}

[TranspilationSource]
public sealed record ListeningSocketInfo(
    FirewallProtocol Protocol,
    string Address,
    int Port,
    ExposureScope Scope,
    ExposureFirewall Firewall,
    string? Process = null,
    int? Pid = null);

[TranspilationSource]
public sealed record ContainerPortInfo(
    string ContainerId,
    string ContainerName,
    string Image,
    FirewallProtocol Protocol,
    string HostAddress,
    int HostPort,
    int ContainerPort,
    ExposureScope Scope,
    ExposureFirewall Firewall,
    int? HostPortTo = null,
    int? ContainerPortTo = null);

/// <summary>Listening sockets (ss) and Docker's published ports, each said to be public or not.</summary>
[TranspilationSource]
public sealed record ExposureInventory(
    ListeningSocketInfo[] Sockets,
    ContainerPortInfo[] Containers,
    bool DockerAvailable,
    long CollectedAtUnixMs,
    string? SocketsError = null,
    string? DockerError = null);
