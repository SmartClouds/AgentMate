using Tapper;

namespace Runova.ServerCore.Contracts;

/// <summary>Who is signed in on this connection, and how.</summary>
[TranspilationSource]
public sealed record AccountInfo(
    Guid UserId,
    string UserName,
    string[] Roles,
    bool TwoFactorEnabled,
    int RecoveryCodesLeft,
    Guid SessionId,
    Guid DeviceId,
    long? StepUpUntilUnixMs = null);

[TranspilationSource]
public sealed record DeviceInfo(
    Guid Id,
    string UserName,
    string Name,
    long CreatedAtUnixMs,
    long? LastSeenAtUnixMs,
    bool Revoked,
    bool Current);

[TranspilationSource]
public sealed record SessionInfo(
    Guid Id,
    Guid DeviceId,
    string DeviceName,
    long CreatedAtUnixMs,
    long LastRenewedAtUnixMs,
    long ExpiresAtUnixMs,
    bool Current);

/// <summary>The password, or a TOTP code when two-factor is on.</summary>
[TranspilationSource]
public sealed record StepUpRequest(string? Password = null, string? TotpCode = null);

[TranspilationSource]
public sealed record StepUpResponse(long StepUpUntilUnixMs);

/// <summary>The new authenticator key, as text and as an otpauth:// link for a QR code.</summary>
[TranspilationSource]
public sealed record TotpSetup(string SharedKey, string AuthenticatorUri);

/// <summary>Shown once; each works one time in place of an authenticator code.</summary>
[TranspilationSource]
public sealed record RecoveryCodes(string[] Codes);

/// <summary>For another device of a user (the caller when no user is named).</summary>
[TranspilationSource]
public sealed record CreateEnrollmentCodeRequest(string? UserName = null, int? ValidMinutes = null);

/// <summary>Shown once. The core keeps only its hash.</summary>
[TranspilationSource]
public sealed record EnrollmentCodeInfo(string Code, string UserName, long ExpiresAtUnixMs);

/// <summary>Redeems an enrollment code: the new device's public key plus the user's password.</summary>
[TranspilationSource]
public sealed record EnrollRequest(string Code, string UserName, string Password, string PublicKey, string DeviceName);

[TranspilationSource]
public sealed record EnrollResponse(Guid DeviceId);

/// <summary>Newest first, a page at a time. Every filter given has to match.</summary>
/// <param name="Action">One action, or every action under a prefix that ends with a dot ("auth.").</param>
/// <param name="Actor">The user who acted, by user name or id.</param>
/// <param name="Result">success, denied, failed or cancelled.</param>
/// <param name="FromUnixMs">Events at or after this time.</param>
/// <param name="ToUnixMs">Events at or before this time.</param>
[TranspilationSource]
public sealed record AuditQuery(
    long? BeforeId = null,
    int? Limit = null,
    string? Action = null,
    string? Actor = null,
    string? Result = null,
    long? FromUnixMs = null,
    long? ToUnixMs = null);

/// <param name="ActorUserName">The actor's user name now, or null when the user is gone or nobody signed in acted.</param>
/// <param name="DeviceName">The device's name now, or null when it is gone or none was involved.</param>
[TranspilationSource]
public sealed record AuditEventInfo(
    long Id,
    long AtUnixMs,
    Guid? ActorUserId,
    Guid? DeviceId,
    int? PeerUid,
    string Action,
    string? Target,
    string? Parameters,
    string Result,
    string? ActorUserName = null,
    string? DeviceName = null);

[TranspilationSource]
public sealed record AuditPage(AuditEventInfo[] Events, long? NextBeforeId = null);

[TranspilationSource]
public sealed record AuditVerificationInfo(bool Intact, int Checked, long? BrokenAt = null);
