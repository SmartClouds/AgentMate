using Tapper;

namespace AgentMate.ServerCore.Contracts;

// Backups (E15): the core's state, encrypted on the server with a passphrase only the user knows
// (PBKDF2-HMAC-SHA256 and AES-256-GCM), then downloaded to the app over REST and deleted. A restore
// runs over SSH as root with `agentmate-core admin restore-stage`, so it works on a core nobody can
// sign in to and on a new server.

/// <summary>The passphrase never leaves the core in any form, and is never stored or logged.</summary>
[TranspilationSource]
public sealed record BackupRequest(string Passphrase);

[TranspilationSource]
public sealed record BackupContents(
    int Users,
    int Devices,
    int Stacks,
    int Sites,
    int Certificates,
    long DatabaseBytes,
    int Files);

/// <summary>A backup waiting on the server to be downloaded (GET /api/v1/backups/{Id}); it goes after ExpiresAtUnixMs.</summary>
[TranspilationSource]
public sealed record BackupInfo(
    Guid Id,
    string FileName,
    long SizeBytes,
    string Sha256,
    long CreatedAtUnixMs,
    long ExpiresAtUnixMs,
    string CoreVersion,
    BackupContents Contents);

// Server backups (E28): the whole server, on demand or on a schedule, encrypted to a key ring
// sealed with a secret key the core never stores, and sent to several destinations at once. Owners
// only; anything that hands out credentials or a backup needs a step-up.

[TranspilationSource]
public enum BackupDestinationKind
{
    /// <summary>A folder on the server itself. Not a backup on its own, but quick to restore from.</summary>
    Folder,
    Ftp,
    Sftp,
    GoogleDrive,
    OneDrive,
    Telegram,
}

[TranspilationSource]
public enum BackupTrigger
{
    Schedule,
    Manual,
    BeforeRestore,
}

[TranspilationSource]
public enum BackupRunState
{
    Running,
    Succeeded,

    /// <summary>Made, but at least one destination did not take it.</summary>
    PartlyFailed,
    Failed,
}

[TranspilationSource]
public enum BackupTargetState
{
    Pending,
    Uploading,
    Succeeded,
    Failed,
}

/// <summary>Whether a secret key is set, and the key ring's id that every backup made since names.</summary>
[TranspilationSource]
public sealed record BackupSecretStatus(bool IsSet, string? KeyId, long? UpdatedAtUnixMs);

/// <summary>Sets the secret key, or changes it (the current one is then required). Neither is stored.</summary>
[TranspilationSource]
public sealed record SetBackupSecretRequest(string? CurrentSecret, string NewSecret);

/// <summary>
/// What is not secret about a destination. Which fields apply depends on the kind: a folder has a
/// Path; FTP and SFTP a Host, Port, UserName and Path (FTP its Tls, SFTP the pinned HostKeySha256);
/// Google Drive and OneDrive the user's own ClientId and the FolderName; Telegram the ApiId, the
/// account's AccountName and IsPremium, and the Chat ("me" for Saved Messages).
/// </summary>
[TranspilationSource]
public sealed record BackupDestinationSettings(
    string? Path = null,
    string? Host = null,
    int? Port = null,
    string? UserName = null,
    bool? Tls = null,
    string? HostKeySha256 = null,
    string? ClientId = null,
    string? FolderName = null,
    int? ApiId = null,
    string? AccountName = null,
    bool? IsPremium = null,
    string? Chat = null);

/// <summary>A destination's credentials, written once and never read back.</summary>
[TranspilationSource]
public sealed record BackupDestinationSecret(
    string? Password = null,
    string? PrivateKey = null,
    string? PrivateKeyPassphrase = null,
    string? ClientSecret = null,
    string? RefreshToken = null,
    string? ApiHash = null,
    string? TelegramLoginId = null);

[TranspilationSource]
public sealed record BackupDestinationInfo(
    Guid Id,
    string Name,
    BackupDestinationKind Kind,
    string Summary,
    BackupDestinationSettings Settings,
    bool HasSecret,
    long? MaxPartBytes,
    long? LastTestedAtUnixMs,
    string? LastError);

/// <summary>Adds a destination (no Id) or changes one. A null Secret keeps the stored credentials.</summary>
[TranspilationSource]
public sealed record SaveBackupDestinationRequest(
    Guid? Id,
    string Name,
    BackupDestinationKind Kind,
    BackupDestinationSettings Settings,
    BackupDestinationSecret? Secret,
    long? MaxPartBytes);

/// <summary>Whether the destination took a small test file and gave it back. HostKeySha256 is what an SFTP server showed.</summary>
[TranspilationSource]
public sealed record BackupDestinationTest(bool Ok, string? Problem, string? HostKeySha256);

[TranspilationSource]
public sealed record BackupPlanInfo(
    Guid Id,
    string Name,
    bool Enabled,
    string Cron,
    string TimeZone,
    int KeepLast,
    int? KeepDays,
    Guid[] DestinationIds,
    long? NextRunAtUnixMs,
    BackupRunInfo? LastRun);

/// <summary>Adds a plan (no Id) or changes one.</summary>
[TranspilationSource]
public sealed record SaveBackupPlanRequest(
    Guid? Id,
    string Name,
    bool Enabled,
    string Cron,
    string TimeZone,
    int KeepLast,
    int? KeepDays,
    Guid[] DestinationIds);

[TranspilationSource]
public sealed record BackupPlanPreviewRequest(Guid? PlanId, string Cron, string TimeZone, int KeepLast, int? KeepDays);

/// <summary>
/// What a plan will do: its next runs, how many backups each destination keeps, about how much room
/// they take (from the last backup's size, when there is one) and when the first one is deleted.
/// </summary>
[TranspilationSource]
public sealed record BackupPlanPreview(
    string? Problem,
    long[] NextRunsUnixMs,
    int Kept,
    long? BytesPerDestination,
    long? FirstDeletionAtUnixMs,
    long CoversMs);

[TranspilationSource]
public sealed record BackupRunTargetInfo(
    Guid DestinationId,
    string DestinationName,
    BackupTargetState State,
    int Attempts,
    int Pruned,
    string? Error);

[TranspilationSource]
public sealed record BackupRunInfo(
    Guid Id,
    Guid? PlanId,
    string? PlanName,
    BackupTrigger Trigger,
    BackupRunState State,
    long StartedAtUnixMs,
    long? FinishedAtUnixMs,
    long? SizeBytes,
    string? Error,
    string? RequestedByName,
    BackupRunTargetInfo[] Targets);

/// <summary>
/// Backs up now, to the destinations named. With KeepForDownload the file also waits an hour on
/// the server for GET /api/v1/backups/{Id}, like an E15 backup.
/// </summary>
[TranspilationSource]
public sealed record RunBackupNowRequest(Guid[] DestinationIds, bool KeepForDownload);

/// <summary>A backup a destination holds, as its manifest says.</summary>
[TranspilationSource]
public sealed record StoredBackupInfo(
    Guid BackupId,
    Guid DestinationId,
    Guid? PlanId,
    string ServerName,
    long CreatedAtUnixMs,
    long SizeBytes,
    int Parts,
    string CoreVersion,
    string KeyId);

[TranspilationSource]
public enum TelegramLoginStep
{
    /// <summary>Telegram sent a code to the account's other sessions or by text.</summary>
    Code,

    /// <summary>The account has two-step verification: its cloud password is next.</summary>
    Password,
    Done,
}

/// <summary>Signs in to a Telegram account with the user's own app id and hash (my.telegram.org).</summary>
[TranspilationSource]
public sealed record StartTelegramLoginRequest(int ApiId, string ApiHash, string PhoneNumber);

[TranspilationSource]
public sealed record ContinueTelegramLoginRequest(string LoginId, string? Code, string? Password);

/// <summary>Where a sign-in stands. Once Done, LoginId goes in a destination's secret as TelegramLoginId.</summary>
[TranspilationSource]
public sealed record TelegramLoginState(string LoginId, TelegramLoginStep Step, string? AccountName, bool? IsPremium, string? Problem);

/// <summary>
/// A backup on a destination being fetched to this server for a restore or a download: joined,
/// checked and kept root-only at Path (/var/lib/agentmate-core/backups/&lt;id&gt;.ambackup) for an hour,
/// where `admin restore-stage` reads it and GET /api/v1/backups/{BackupId} serves it.
/// </summary>
[TranspilationSource]
public sealed record BackupFetchInfo(
    Guid Id,
    Guid BackupId,
    BackupRunState State,
    long SizeBytes,
    long BytesDone,
    string? Path,
    string? Error);

/// <summary>One setting that named the server's old address, and what it becomes.</summary>
[TranspilationSource]
public sealed record AddressChange(string Area, string Target, string From, string To, bool Automatic, string? Note);

/// <summary>
/// What a restored state still has to do on this server after the swap: its server/ folder holds
/// the volumes, images, containers and firewall rules of the server it came from. NewAddresses
/// are this server's; when they differ from OldAddresses, AddressChanges is what moving them does.
/// </summary>
[TranspilationSource]
public sealed record PendingServerRestore(
    string HostName,
    long CreatedAtUnixMs,
    string[] OldAddresses,
    string[] NewAddresses,
    int Volumes,
    int SavedImages,
    int PulledImages,
    int Containers,
    string[] Projects,
    FirewallRuleSpec[] FirewallRules,
    AddressChange[] AddressChanges,
    bool LiveCopy);

/// <summary>Brings the restored server up. MoveAddresses applies every automatic AddressChange.</summary>
[TranspilationSource]
public sealed record RunServerRestoreRequest(bool MoveAddresses);

[TranspilationSource]
public sealed record ServerRestoreStep(string Name, BackupTargetState State, string? Detail);

/// <summary>
/// How bringing the server up goes. ManualDns lists hostnames on DNS the core cannot change, to be
/// pointed at the new address by hand; the firewall rules are applied from the app, with a
/// confirmation, like any firewall change.
/// </summary>
[TranspilationSource]
public sealed record ServerRestoreStatus(
    BackupRunState State,
    ServerRestoreStep[] Steps,
    AddressChange[] Applied,
    string[] ManualDns,
    string? Error);
