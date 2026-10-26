using Tapper;

namespace Runova.ServerCore.Contracts;

// The Security center (E15): a checklist of how safe the server is, and the SSH changes it can
// make. SSH changes work like firewall changes: the core writes its own sshd drop-in, arms a
// systemd timer that puts the old one back after a minute, reloads sshd, and keeps the change only
// when a new SSH connection that signed in with a key confirms it. Turning off passwords is refused
// outright unless the connection asking signed in with a key.

/// <summary>sshd's effective settings (`sshd -T`), null where it did not say.</summary>
[TranspilationSource]
public sealed record SshPolicyInfo(
    bool? PasswordLogin,
    bool? KeyboardInteractiveLogin,
    bool? KeyLogin,
    string? RootLogin,
    bool ManagedByRunova,
    string? Error = null);

/// <summary>How the SSH connection a call came over signed in, as sshd logged it.</summary>
[TranspilationSource]
public sealed record SshLoginProof(
    bool KeyLoginProven,
    string Explanation,
    string? Method = null,
    string? UserName = null,
    long? AtUnixMs = null);

/// <summary>What to change. Root login is only ever restricted to keys, never turned off, so a root key login keeps working.</summary>
[TranspilationSource]
public sealed record SshHardeningRequest(bool DisablePasswordLogin, bool RestrictRootLogin);

/// <summary>The exact file and commands a change would write and run, and whether this connection may make it.</summary>
[TranspilationSource]
public sealed record SshHardeningPreview(
    string Summary,
    string Path,
    string Content,
    string[] Commands,
    SshLoginProof Proof,
    bool Allowed,
    int ConfirmWithinSeconds,
    string[] Notes);

[TranspilationSource]
public enum SshHardeningState
{
    AwaitingConfirmation,
    Confirmed,
    RolledBack,
    Failed,
}

[TranspilationSource]
public sealed record SshHardeningChangeInfo(
    Guid Id,
    SshHardeningState State,
    string Summary,
    long CreatedAtUnixMs,
    long DeadlineUnixMs,
    string RequestedBy,
    long? FinishedAtUnixMs = null,
    string? Error = null);

[TranspilationSource]
public enum ChecklistStatus
{
    Pass,

    /// <summary>Worth fixing, but not an open door.</summary>
    Warn,
    Fail,

    /// <summary>The core could not tell; left out of the score.</summary>
    Unknown,
}

/// <summary>What the app can do about an item. Links open the screen that fixes it; the others are one-click fixes with a preview.</summary>
[TranspilationSource]
public enum ChecklistFix
{
    None,
    EnableFirewall,
    DisableSshPasswordLogin,
    RestrictRootLogin,
    EnableAutomaticUpdates,
    Reboot,
    ReviewExposure,
    RenewCertificates,
    UpdateCore,
    EnableTwoFactor,
}

/// <param name="Targets">What the fix acts on: the sites whose certificates to renew, the Owners without two-factor.</param>
[TranspilationSource]
public sealed record ChecklistItem(
    string Id,
    string Title,
    ChecklistStatus Status,
    int Weight,
    string Detail,
    ChecklistFix Fix,
    string[] Targets);

/// <summary>Score 0 to 100 over the items the core could judge, each counted by its weight (a warning counts half).</summary>
[TranspilationSource]
public sealed record SecurityChecklist(
    int Score,
    ChecklistItem[] Items,
    SshPolicyInfo Ssh,
    string CoreVersion,
    long CheckedAtUnixMs,
    SshHardeningChangeInfo? PendingSshChange = null);

/// <param name="AvailableCoreVersion">The core release the app can install, which only the app knows.</param>
[TranspilationSource]
public sealed record SecurityChecklistRequest(string? AvailableCoreVersion = null);
