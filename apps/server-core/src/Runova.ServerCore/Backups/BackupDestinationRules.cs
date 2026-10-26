using System.Globalization;
using System.Net;
using System.Text.RegularExpressions;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Nginx;

namespace Runova.ServerCore.Backups;

/// <summary>What each kind of destination needs before the core keeps it (E28), and how it reads in a list.</summary>
internal static partial class BackupDestinationRules
{
    public const int MaxNameLength = 100;
    public const long MinPartBytes = 1024 * 1024;
    public const long TelegramPartBytes = 2000L * 1024 * 1024;
    public const long TelegramPremiumPartBytes = 4000L * 1024 * 1024;
    public const string DefaultFolderName = "Runova Backups";

    private static readonly string[] _systemRoots = ["/proc", "/sys", "/dev", "/run", "/boot", "/etc", "/bin", "/sbin", "/usr", "/lib", "/lib64"];

    /// <summary>
    /// Why a destination will not do, or null. A secret is checked only when one is sent: without it
    /// the stored one stays, so a change of folder needs no password again.
    /// </summary>
    public static string? Problem(string? name, BackupDestinationKind kind, BackupDestinationSettings? settings, BackupDestinationSecret? secret, bool hasStoredSecret, long? maxPartBytes)
    {
        if (string.IsNullOrWhiteSpace(name) || name.Trim().Length > MaxNameLength)
        {
            return $"Give the destination a name of at most {MaxNameLength} characters.";
        }

        if (maxPartBytes is { } part && part < MinPartBytes)
        {
            return "Parts have to be at least 1 MB.";
        }

        settings ??= new BackupDestinationSettings();
        var needsSecret = secret is null && !hasStoredSecret;
        return kind switch
        {
            BackupDestinationKind.Folder => FolderProblem(settings.Path),
            BackupDestinationKind.Ftp => ServerProblem(settings)
                ?? (needsSecret || (secret is not null && string.IsNullOrEmpty(secret.Password)) ? "Enter the FTP password." : null),
            BackupDestinationKind.Sftp => ServerProblem(settings)
                ?? (BackupNaming.IsSha256(settings.HostKeySha256) ? null : "Test the connection and confirm the server's host key first.")
                ?? (needsSecret || (secret is not null && string.IsNullOrEmpty(secret.Password) && string.IsNullOrEmpty(secret.PrivateKey))
                    ? "Enter a password or a private key."
                    : null),
            BackupDestinationKind.GoogleDrive or BackupDestinationKind.OneDrive => DriveProblem(settings)
                ?? (needsSecret || (secret is not null && string.IsNullOrEmpty(secret.RefreshToken)) ? "Sign in to the account first." : null),
            BackupDestinationKind.Telegram => settings.ApiId is not > 0
                ? "Enter the app's api_id from my.telegram.org."
                : needsSecret || (secret is not null && (secret.ApiHash is null || !ApiHash().IsMatch(secret.ApiHash)))
                    ? "Enter the app's api_hash from my.telegram.org (32 characters)."
                    : secret is not null && string.IsNullOrEmpty(secret.TelegramLoginId)
                        ? "Sign in to the Telegram account first."
                        : null,
            _ => "That kind of destination is not known.",
        };
    }

    /// <summary>The size parts are cut to, or null for one file. Telegram's own limit always applies.</summary>
    public static long? PartBytes(BackupDestinationKind kind, BackupDestinationSettings settings, long? maxPartBytes)
    {
        if (kind != BackupDestinationKind.Telegram)
        {
            return maxPartBytes;
        }

        var limit = settings.IsPremium == true ? TelegramPremiumPartBytes : TelegramPartBytes;
        return Math.Min(limit, maxPartBytes ?? limit);
    }

    public static string Summary(BackupDestinationKind kind, BackupDestinationSettings settings) => kind switch
    {
        BackupDestinationKind.Folder => settings.Path ?? string.Empty,
        BackupDestinationKind.Ftp => string.Create(CultureInfo.InvariantCulture, $"{(settings.Tls == true ? "ftps" : "ftp")}://{settings.UserName}@{settings.Host}:{settings.Port ?? 21}{settings.Path ?? "/"}"),
        BackupDestinationKind.Sftp => string.Create(CultureInfo.InvariantCulture, $"sftp://{settings.UserName}@{settings.Host}:{settings.Port ?? 22}{settings.Path ?? "/"}"),
        BackupDestinationKind.GoogleDrive => $"Google Drive, {settings.FolderName ?? DefaultFolderName}",
        BackupDestinationKind.OneDrive => $"OneDrive, {settings.FolderName ?? DefaultFolderName}",
        BackupDestinationKind.Telegram => settings.Chat is null or "me"
            ? $"Telegram, Saved Messages of {settings.AccountName ?? "the account"}"
            : $"Telegram, {settings.Chat}",
        _ => string.Empty,
    };

    private static string? FolderProblem(string? path)
    {
        if (string.IsNullOrWhiteSpace(path) || !path.StartsWith('/') || path.Length > 1024)
        {
            return "The folder has to be a full path on the server, like /var/backups/runova.";
        }

        var segments = path.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (segments.Length == 0 || segments.Any(segment => segment is "." or ".."))
        {
            return "The folder has to be a plain full path, without . or .. in it.";
        }

        var normal = "/" + string.Join('/', segments);
        return _systemRoots.Any(root => normal == root || normal.StartsWith(root + "/", StringComparison.Ordinal))
            ? $"{normal} is a system folder. Pick one like /var/backups/runova."
            : null;
    }

    private static string? ServerProblem(BackupDestinationSettings settings)
    {
        if (string.IsNullOrWhiteSpace(settings.Host)
            || (!IPAddress.TryParse(settings.Host, out _) && NginxNames.DomainProblem(settings.Host) is not null))
        {
            return "Enter the server's host name or address.";
        }

        if (settings.Port is < 1 or > 65535)
        {
            return "The port is between 1 and 65535.";
        }

        if (string.IsNullOrWhiteSpace(settings.UserName) || settings.UserName.Length > 256)
        {
            return "Enter the user name.";
        }

        return settings.Path is { } path && (!path.StartsWith('/') || path.Split('/').Any(segment => segment == "..") || path.Length > 1024)
            ? "The folder on the server has to be a full path, like /backups."
            : null;
    }

    private static string? DriveProblem(BackupDestinationSettings settings)
    {
        if (string.IsNullOrWhiteSpace(settings.ClientId) || settings.ClientId.Length > 256)
        {
            return "Enter the OAuth client id of your own app.";
        }

        return settings.FolderName is { } folder && (folder.Length is 0 or > 100 || folder.IndexOfAny(['/', '\\']) >= 0)
            ? "The folder name is one folder, without / in it."
            : null;
    }

    [GeneratedRegex("^[0-9a-f]{32}$", RegexOptions.CultureInvariant)]
    private static partial Regex ApiHash();
}
