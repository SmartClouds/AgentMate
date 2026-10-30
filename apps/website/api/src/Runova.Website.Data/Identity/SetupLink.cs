namespace Runova.Website.Data.Identity;

/// <summary>
/// A one-time link a user sets their password with, from an invitation or a password reset. Only
/// the token's SHA-256 is stored. A link is deleted when it is used or replaced, so a user has at
/// most one.
/// </summary>
public class SetupLink
{
    public long Id { get; set; }

    public long UserId { get; set; }

    /// <summary>One of <see cref="SetupLinkPurposes"/>.</summary>
    public string Purpose { get; set; } = "";

    public byte[] TokenHash { get; set; } = [];

    public DateTimeOffset CreatedAt { get; set; }

    public DateTimeOffset ExpiresAt { get; set; }
}

public static class SetupLinkPurposes
{
    public const string Invitation = "invitation";
    public const string PasswordReset = "password-reset";
}
