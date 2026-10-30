using Microsoft.AspNetCore.Identity;
using Runova.Website.Core.Identity;
using Runova.Website.Core.Users;
using Runova.Website.Data.Identity;

namespace Runova.Website.Api.Users;

/// <summary>Builds a <see cref="UserDto"/> from a user and their roles.</summary>
internal static class UserViews
{
    public static async Task<UserDto> ToDtoAsync(this UserManager<AppUser> users, AppUser user, TimeProvider time) =>
        ToDto(user, await users.GetRolesAsync(user), time);

    /// <summary>Roles come in the order of <see cref="Roles.All"/>, and a lockout only while it lasts.</summary>
    public static UserDto ToDto(AppUser user, IEnumerable<string> roles, TimeProvider time)
    {
        var lockedOutUntil = user.LockoutEnd > time.GetUtcNow() ? user.LockoutEnd : null;
        return UserMapper.ToDto(user, [.. Roles.All.Intersect(roles)], lockedOutUntil);
    }
}
