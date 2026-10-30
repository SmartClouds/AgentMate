using Riok.Mapperly.Abstractions;

namespace Runova.Website.Core.Users;

[Mapper]
public static partial class UserMapper
{
    /// <summary>
    /// Roles live in their own table and the lockout end only counts while it lies ahead, so the
    /// caller passes both.
    /// </summary>
    [MapPropertyFromSource(nameof(UserDto.Disabled), Use = nameof(IsDisabled))]
    public static partial UserDto ToDto(IStaffUser user, IReadOnlyList<string> roles, DateTimeOffset? lockedOutUntil);

    private static bool IsDisabled(IStaffUser user) => user.DisabledAt is not null;
}
