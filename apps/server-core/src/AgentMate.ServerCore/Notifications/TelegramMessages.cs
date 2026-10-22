using AgentMate.ServerCore.Contracts;

namespace AgentMate.ServerCore.Notifications;

/// <summary>What changed about an alert that is worth a message.</summary>
internal enum TelegramChange
{
    Opened,
    Worse,
    Resolved,
}

/// <summary>
/// The words of a message: how bad, which server, what kind of problem, then the alert's own message.
/// The titles say the same as the app's notifications (desktop <c>watcher.ts</c>), without the server,
/// which leads every message instead.
/// </summary>
internal static class TelegramMessages
{
    /// <summary>The longest text Telegram takes in one message.</summary>
    public const int MaxLength = 4096;

    public static string Title(AlertKind kind, AlertSeverity severity) => kind switch
    {
        AlertKind.DiskPressure => severity == AlertSeverity.Critical ? "A disk is nearly full" : "A disk is filling up",
        AlertKind.JobFailed => "A job failed",
        AlertKind.RebootRequired => "The server needs a reboot",
        AlertKind.FirewallRolledBack => "A firewall change was rolled back",
        AlertKind.FirewallRollbackFailed => "A firewall change could not be rolled back",
        AlertKind.CertificateRenewalFailed => "A certificate did not renew",
        AlertKind.OriginLockRefreshFailed => "The Cloudflare lock could not be refreshed",
        AlertKind.BackupFailed => "A backup failed",
        AlertKind.ContainerCrashLoop => "A container keeps restarting",
        _ => "Something needs a look",
    };

    public static string Compose(AlertInfo alert, string serverName, TelegramChange change)
    {
        ArgumentNullException.ThrowIfNull(alert);
        var title = Title(alert.Kind, alert.Severity);
        var text = change switch
        {
            TelegramChange.Resolved => $"✅ Resolved on {serverName}: {title}\nIt was: {alert.Message}",
            TelegramChange.Worse => $"{Mark(alert.Severity)} Now {Level(alert.Severity).ToLowerInvariant()} on {serverName}: {title}\n{alert.Message}",
            _ => $"{Mark(alert.Severity)} {Level(alert.Severity)} on {serverName}: {title}\n{alert.Message}",
        };
        return Clip(text);
    }

    public static string Test(string serverName, string requestedBy) =>
        $"✅ AgentMate test from {serverName}, sent by {requestedBy}. Alerts from this server will arrive in this chat.";

    private static string Mark(AlertSeverity severity) => severity switch
    {
        AlertSeverity.Critical => "🔴",
        AlertSeverity.Warning => "🟠",
        _ => "🔵",
    };

    private static string Level(AlertSeverity severity) => severity switch
    {
        AlertSeverity.Critical => "Critical",
        AlertSeverity.Warning => "Warning",
        _ => "Note",
    };

    private static string Clip(string text) =>
        text.Length <= MaxLength ? text : text[..(MaxLength - 1)] + "…";
}
