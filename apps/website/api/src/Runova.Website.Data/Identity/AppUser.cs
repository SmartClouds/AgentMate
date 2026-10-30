using Microsoft.AspNetCore.Identity;
using Runova.Website.Core.Users;

namespace Runova.Website.Data.Identity;

/// <summary>A staff user. Every one is made by an Admin or the CLI; there is no public sign-up.</summary>
public class AppUser : IdentityUser<long>, IStaffUser
{
    public string DisplayName { get; set; } = "";

    public DateTimeOffset CreatedAt { get; set; }

    /// <summary>Set when an Admin disables the user; a disabled user can not sign in.</summary>
    public DateTimeOffset? DisabledAt { get; set; }

    public DateTimeOffset? LastSignInAt { get; set; }

    /// <summary>
    /// The last TOTP time step a code was accepted for. A code from that step or an earlier one is
    /// refused, so each code works once.
    /// </summary>
    public long? LastTotpTimeStep { get; set; }

    /// <summary>PostgreSQL's <c>xmin</c>, the row version behind the ETag.</summary>
    public uint Version { get; set; }

    string IStaffUser.Email => Email ?? "";
}
