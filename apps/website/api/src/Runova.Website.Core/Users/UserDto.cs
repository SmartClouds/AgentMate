namespace Runova.Website.Core.Users;

/// <summary>A staff user as the contract's <c>UserDto</c> shows it.</summary>
public sealed record UserDto(
    long Id,
    string Email,
    string DisplayName,
    IReadOnlyList<string> Roles,
    bool Disabled,
    bool EmailConfirmed,
    bool TwoFactorEnabled,
    DateTimeOffset? LockedOutUntil,
    DateTimeOffset? LastSignInAt,
    DateTimeOffset CreatedAt,
    string Version);

/// <summary>
/// What a staff user's DTO is made from. The Identity user in Runova.Website.Data implements it,
/// so the mapper lives here without Core knowing Identity.
/// </summary>
public interface IStaffUser
{
    long Id { get; }

    string Email { get; }

    string DisplayName { get; }

    DateTimeOffset? DisabledAt { get; }

    bool EmailConfirmed { get; }

    bool TwoFactorEnabled { get; }

    DateTimeOffset? LastSignInAt { get; }

    DateTimeOffset CreatedAt { get; }

    /// <summary>PostgreSQL's <c>xmin</c>, the row version.</summary>
    uint Version { get; }
}
