using System.Reflection;
using Microsoft.AspNetCore.Identity;
using Runova.ServerCore.Data;

namespace Runova.ServerCore.Security;

/// <summary>The four roles, from most to least powerful. Each includes what the ones below may do.</summary>
internal static class CoreRoles
{
    public const string Owner = "owner";
    public const string Admin = "admin";
    public const string Operator = "operator";
    public const string Viewer = "viewer";

    public static readonly string[] All = [Owner, Admin, Operator, Viewer];

    /// <summary>The most powerful of these roles, or null when none of them is one of the four.</summary>
    public static string? Highest(IEnumerable<string?> roles)
    {
        var held = roles.ToHashSet(StringComparer.Ordinal);
        return All.FirstOrDefault(held.Contains);
    }
}

/// <summary>
/// Identity settings: long passwords rather than composition rules (NIST SP 800-63B), checked
/// against common passwords; PBKDF2 at the iteration count OWASP gives for HMAC-SHA512; a lockout
/// after five wrong passwords.
/// </summary>
internal static class CoreIdentity
{
    public const int MinPasswordLength = 12;
    public const int MaxPasswordLength = 256;

    /// <summary>OWASP's figure for PBKDF2-HMAC-SHA512, which Identity's v3 hashes use.</summary>
    public const int Pbkdf2Iterations = 210_000;

    public const int MaxFailedAttempts = 5;
    public static readonly TimeSpan LockoutDuration = TimeSpan.FromMinutes(15);

    /// <summary>
    /// An Owner turns an account off by locking it until the end of time, which every sign-in
    /// check already honours; a lockout for wrong passwords never reaches that far.
    /// </summary>
    public static readonly DateTimeOffset DisabledUntil = DateTimeOffset.MaxValue;

    public const string DisabledMessage = "This account is disabled. An Owner of this core can turn it on again.";

    public static bool IsDisabled(CoreUser user)
    {
        ArgumentNullException.ThrowIfNull(user);
        return user.LockoutEnabled && user.LockoutEnd is { Year: >= 9999 };
    }

    public static void Configure(IdentityOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        options.Password.RequiredLength = MinPasswordLength;
        options.Password.RequireDigit = false;
        options.Password.RequireLowercase = false;
        options.Password.RequireUppercase = false;
        options.Password.RequireNonAlphanumeric = false;
        options.Password.RequiredUniqueChars = 1;

        options.Lockout.AllowedForNewUsers = true;
        options.Lockout.MaxFailedAccessAttempts = MaxFailedAttempts;
        options.Lockout.DefaultLockoutTimeSpan = LockoutDuration;

        options.User.RequireUniqueEmail = false;
        options.User.AllowedUserNameCharacters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._@";
    }
}

/// <summary>
/// Refuses passwords that are too long to hash cheaply, contain the user name, or appear in a list
/// of common passwords (see Security/CommonPasswords). The list is compared in lower case.
/// </summary>
internal sealed class CommonPasswordValidator : IPasswordValidator<CoreUser>
{
    private static readonly Lazy<HashSet<string>> _common = new(Load);

    public Task<IdentityResult> ValidateAsync(UserManager<CoreUser> manager, CoreUser user, string? password)
    {
        ArgumentNullException.ThrowIfNull(user);
        if (string.IsNullOrEmpty(password))
        {
            return Task.FromResult(IdentityResult.Success);
        }

        var errors = new List<IdentityError>();
        if (password.Length > CoreIdentity.MaxPasswordLength)
        {
            errors.Add(new IdentityError
            {
                Code = "PasswordTooLong",
                Description = $"Passwords can be at most {CoreIdentity.MaxPasswordLength} characters.",
            });
        }

        if (user.UserName is { Length: >= 3 } name && password.Contains(name, StringComparison.OrdinalIgnoreCase))
        {
            errors.Add(new IdentityError
            {
                Code = "PasswordContainsUserName",
                Description = "The password cannot contain the user name.",
            });
        }

        if (_common.Value.Contains(password.ToLowerInvariant()))
        {
            errors.Add(new IdentityError
            {
                Code = "PasswordTooCommon",
                Description = "That password is too common; it appears in lists attackers try first.",
            });
        }

        return Task.FromResult(errors.Count == 0 ? IdentityResult.Success : IdentityResult.Failed([.. errors]));
    }

    private static HashSet<string> Load()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("Runova.ServerCore.CommonPasswords")
            ?? throw new InvalidOperationException("The common password list is missing from the build.");
        using var reader = new StreamReader(stream);
        var set = new HashSet<string>(StringComparer.Ordinal);
        while (reader.ReadLine() is { } line)
        {
            if (line.Length > 0)
            {
                set.Add(line);
            }
        }

        return set;
    }
}
