using Microsoft.AspNetCore.Identity;
using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.Data;

// Timestamps are unix milliseconds throughout: SQLite has no date type, and a number sorts and
// compares the same way in SQL as in code.

/// <summary>A person who can sign in to this core.</summary>
internal sealed class CoreUser : IdentityUser<Guid>
{
    public long CreatedAt { get; set; }

    /// <summary>
    /// The newest 30-second step an authenticator code was accepted for. That code and every older
    /// one are spent (see OneTimeAuthenticatorTokenProvider).
    /// </summary>
    public long LastTotpStep { get; set; }
}

internal sealed class CoreRole : IdentityRole<Guid>
{
}

/// <summary>A desktop that holds a private key; every sign-in and renewal is signed with it.</summary>
internal sealed class Device
{
    public Guid Id { get; set; }

    public Guid UserId { get; set; }

    public required string Name { get; set; }

    /// <summary>The P-256 public key as SubjectPublicKeyInfo (DER).</summary>
    public required byte[] PublicKey { get; set; }

    public long CreatedAt { get; set; }

    public long? LastSeenAt { get; set; }

    public long? RevokedAt { get; set; }
}

/// <summary>One sign-in of one device. Renewing it needs a fresh signature, never a stored secret.</summary>
internal sealed class DeviceSession
{
    public Guid Id { get; set; }

    public Guid DeviceId { get; set; }

    public Guid UserId { get; set; }

    public long CreatedAt { get; set; }

    public long LastRenewedAt { get; set; }

    /// <summary>The absolute end. Renewals never move it.</summary>
    public long ExpiresAt { get; set; }

    public long? RevokedAt { get; set; }

    /// <summary>Until when sensitive actions go ahead without asking for the password again.</summary>
    public long? StepUpUntil { get; set; }

    /// <summary>The user's security stamp at sign-in. A password reset changes it, which ends the session.</summary>
    public required string SecurityStamp { get; set; }
}

/// <summary>A single-use code an Owner creates so another device can enroll.</summary>
internal sealed class EnrollmentCode
{
    public Guid Id { get; set; }

    public Guid UserId { get; set; }

    public Guid CreatedBy { get; set; }

    /// <summary>SHA-256 of the code. The code itself is shown once and never stored.</summary>
    public required string CodeHash { get; set; }

    public long CreatedAt { get; set; }

    public long ExpiresAt { get; set; }

    public long? RedeemedAt { get; set; }
}

/// <summary>One entry of the hash-chained audit trail.</summary>
internal sealed class AuditEvent
{
    public long Id { get; set; }

    public long At { get; set; }

    public Guid? ActorUserId { get; set; }

    public Guid? DeviceId { get; set; }

    /// <summary>The Unix user on the other end of the socket, when the core could tell.</summary>
    public int? PeerUid { get; set; }

    public required string Action { get; set; }

    public string? Target { get; set; }

    /// <summary>Redacted parameters as JSON.</summary>
    public string? Parameters { get; set; }

    public required string Result { get; set; }

    public required string PrevHash { get; set; }

    public required string Hash { get; set; }
}

/// <summary>Where the chain continues after old events were pruned.</summary>
internal sealed class AuditAnchor
{
    public int Id { get; set; }

    public long LastPrunedId { get; set; }

    public required string LastPrunedHash { get; set; }
}

/// <summary>A job's row. Its log lives in a file of its own under the data folder (jobs/&lt;id&gt;.log).</summary>
internal sealed class Job
{
    public Guid Id { get; set; }

    public JobKind Kind { get; set; }

    public required string Title { get; set; }

    public JobState State { get; set; }

    /// <summary>What the job works on, as shown (a service name); locks are kept in memory.</summary>
    public string? Resource { get; set; }

    public Guid? RequestedBy { get; set; }

    public string? RequestedByName { get; set; }

    public long CreatedAt { get; set; }

    public long? FinishedAt { get; set; }

    public int? ExitCode { get; set; }

    /// <summary>Why it failed, redacted.</summary>
    public string? Error { get; set; }

    /// <summary>Lines in the log, written when the job ends (a running job counts in memory).</summary>
    public long LogLines { get; set; }

    public bool Cancellable { get; set; }
}

/// <summary>One condition on one resource. Open until the condition clears; acknowledging only quiets it.</summary>
internal sealed class Alert
{
    public long Id { get; set; }

    /// <summary>Raised on every change, higher than any before, so clients can resume from it.</summary>
    public long Revision { get; set; }

    public AlertKind Kind { get; set; }

    public AlertSeverity Severity { get; set; }

    public required string Resource { get; set; }

    /// <summary>Redacted before it is stored.</summary>
    public required string Message { get; set; }

    public long FirstSeenAt { get; set; }

    public long LastSeenAt { get; set; }

    public int Occurrences { get; set; }

    public long? AcknowledgedAt { get; set; }

    public Guid? AcknowledgedBy { get; set; }

    public string? AcknowledgedByName { get; set; }

    public long? ResolvedAt { get; set; }
}

/// <summary>
/// Downsampled metrics: 1-minute averages for 48 hours and 15-minute averages for 30 days. Live
/// readings stay in memory.
/// </summary>
internal sealed class MetricSample
{
    /// <summary>Seconds per sample: 60 or 900.</summary>
    public int Resolution { get; set; }

    /// <summary>The start of the period the sample covers.</summary>
    public long At { get; set; }

    public double CpuPercent { get; set; }

    public double CpuIowaitPercent { get; set; }

    public double CpuStealPercent { get; set; }

    public double Load1 { get; set; }

    public double Load5 { get; set; }

    public double Load15 { get; set; }

    public long MemoryTotalBytes { get; set; }

    public long MemoryUsedBytes { get; set; }

    public long SwapTotalBytes { get; set; }

    public long SwapUsedBytes { get; set; }

    public double NetworkReceiveBytesPerSecond { get; set; }

    public double NetworkTransmitBytesPerSecond { get; set; }

    public double DiskReadBytesPerSecond { get; set; }

    public double DiskWriteBytesPerSecond { get; set; }

    public long DiskTotalBytes { get; set; }

    public long DiskUsedBytes { get; set; }
}

/// <summary>
/// One firewall change set: what it does, the commands it ran and how it ended. The rules saved
/// before it and the decision between keeping it and rolling it back live in a folder of their own
/// (firewall/&lt;id&gt; in the state folder), where the rollback timer finds them without the core.
/// </summary>
internal sealed class FirewallChangeSet
{
    public Guid Id { get; set; }

    public FirewallBackendKind Backend { get; set; }

    public FirewallChangeState State { get; set; }

    public required string Summary { get; set; }

    /// <summary>The changes as asked for, as JSON.</summary>
    public required string Changes { get; set; }

    /// <summary>The commands it runs, as shown to the person, as a JSON array.</summary>
    public required string Commands { get; set; }

    public long CreatedAt { get; set; }

    /// <summary>When the rollback timer puts the saved rules back unless the change is confirmed.</summary>
    public long? DeadlineAt { get; set; }

    public long? FinishedAt { get; set; }

    public Guid? RequestedBy { get; set; }

    public string? RequestedByName { get; set; }

    public Guid? DeviceId { get; set; }

    /// <summary>The connection that applied it; the confirmation has to come over another one.</summary>
    public required string AppliedOver { get; set; }

    /// <summary>Whether <see cref="AppliedOver"/> names an SSH connection rather than only the socket connection.</summary>
    public bool AppliedOverSsh { get; set; }

    /// <summary>This computer's address as the server saw it.</summary>
    public string? AppliedFrom { get; set; }

    public bool GuardOverridden { get; set; }

    public FirewallRollbackCause? RolledBackBy { get; set; }

    /// <summary>Why it failed or was rolled back, redacted.</summary>
    public string? Error { get; set; }
}
