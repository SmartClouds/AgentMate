using Tapper;

namespace Runova.ServerCore.Contracts;

// Managing who can sign in to this core. Only an Owner sees or changes other users, and every
// change needs a step-up. Passwords only ever travel inwards: no answer carries one.

/// <summary>A user of this core, as an Owner sees them.</summary>
/// <param name="Role">The most powerful role the user holds (owner, admin, operator or viewer), or null for none.</param>
/// <param name="Disabled">An Owner turned the account off: it cannot sign in until turned on again.</param>
/// <param name="LockedOutUntilUnixMs">Locked by too many wrong passwords, until then. Null when not locked or when disabled.</param>
/// <param name="LastSignInAtUnixMs">The newest sign-in from any device, or null when there has been none.</param>
/// <param name="CreatedAtUnixMs">0 when the core does not know (users made before it kept the time).</param>
/// <param name="Devices">Enrolled devices that are not revoked.</param>
/// <param name="Current">The signed-in caller.</param>
[TranspilationSource]
public sealed record UserInfo(
    Guid Id,
    string UserName,
    string? Role,
    bool TwoFactorEnabled,
    bool Disabled,
    long? LockedOutUntilUnixMs,
    long? LastSignInAtUnixMs,
    long CreatedAtUnixMs,
    int Devices,
    bool Current);

/// <summary>A new user with one role and a first password, which the core's password rules check.</summary>
[TranspilationSource]
public sealed record CreateUserRequest(string UserName, string Password, string Role);

/// <summary>A new password for someone else's account. Every session of theirs ends.</summary>
[TranspilationSource]
public sealed record ResetUserPasswordRequest(Guid UserId, string Password);
