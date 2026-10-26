using Tapper;

namespace Runova.ServerCore.Contracts;

// Sign-in is the one part of the API on REST: it runs before there is a token to open the hub.
// Each step signs a single-use challenge with the device key; see AuthMessage for the exact text.

/// <summary>What a challenge will be spent on. A challenge only works for the purpose it was issued for.</summary>
[TranspilationSource]
public enum AuthPurpose
{
    Login,
    Renew,
}

/// <summary>Asks for a challenge. A renewal challenge names the session it will renew.</summary>
[TranspilationSource]
public sealed record ChallengeRequest(Guid DeviceId, AuthPurpose Purpose, Guid? SessionId = null);

/// <summary>A single-use nonce to sign, valid for one minute.</summary>
[TranspilationSource]
public sealed record ChallengeResponse(Guid ChallengeId, string Nonce, long ExpiresAtUnixMs);

/// <summary>The device's signature over the challenge plus the user's password, and the second factor when on.</summary>
[TranspilationSource]
public sealed record LoginRequest(
    Guid ChallengeId,
    Guid DeviceId,
    string Signature,
    string UserName,
    string Password,
    string? TotpCode = null,
    string? RecoveryCode = null);

/// <summary>A fresh signature for an existing session. No password and no stored secret.</summary>
[TranspilationSource]
public sealed record RenewRequest(Guid ChallengeId, Guid SessionId, string Signature);

[TranspilationSource]
public sealed record SignedInUser(Guid Id, string UserName, string[] Roles, bool TwoFactorEnabled);

/// <summary>A session and a 15-minute access token for the hub.</summary>
[TranspilationSource]
public sealed record SignedInResponse(Guid SessionId, string AccessToken, long AccessTokenExpiresAtUnixMs, SignedInUser User);

/// <summary>Why a sign-in step failed, in terms the app can act on.</summary>
[TranspilationSource]
public enum AuthErrorCode
{
    /// <summary>Missing, used, expired or issued for something else. Ask for a new one.</summary>
    ChallengeInvalid,

    /// <summary>This core does not know the device: enroll it.</summary>
    DeviceUnknown,

    /// <summary>The device was revoked: enroll it again.</summary>
    DeviceRevoked,

    /// <summary>A wrong password or a wrong signature; deliberately the same code.</summary>
    InvalidCredentials,

    LockedOut,

    TotpRequired,

    TotpInvalid,

    /// <summary>Idle too long or past its absolute end: sign in again.</summary>
    SessionExpired,

    /// <summary>Signed out, revoked, or the password changed: sign in again.</summary>
    SessionRevoked,

    RateLimited,

    /// <summary>The enrollment code is wrong, used, expired or for someone else.</summary>
    EnrollmentCodeInvalid,

    /// <summary>The device key is not a P-256 public key.</summary>
    KeyInvalid,
}

[TranspilationSource]
public sealed record AuthError(AuthErrorCode Code, string Message, long? LockedOutUntilUnixMs = null);
