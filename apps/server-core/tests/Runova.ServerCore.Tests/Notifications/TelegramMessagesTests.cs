using Runova.ServerCore.Contracts;
using Runova.ServerCore.Notifications;

namespace Runova.ServerCore.Tests.Notifications;

/// <summary>
/// What a message says: how bad, which server, what kind of problem, then the alert's own words.
/// Short enough to read on a lock screen, and never longer than Telegram takes.
/// </summary>
public sealed class TelegramMessagesTests
{
    private static AlertInfo Alert(
        AlertKind kind = AlertKind.BackupFailed,
        AlertSeverity severity = AlertSeverity.Critical,
        string message = "Nightly DB: the archive could not be built: disk full") =>
        new(7, 3, kind, severity, "backup-plan:1", message, 1_000, 1_000, 1);

    [Fact]
    public void A_new_problem_starts_with_how_bad_it_is_and_the_server_then_says_what_happened()
    {
        var text = TelegramMessages.Compose(Alert(), "prod-1", TelegramChange.Opened);

        Assert.Equal("🔴 Critical on prod-1: A backup failed\nNightly DB: the archive could not be built: disk full", text);
    }

    [Theory]
    [InlineData(AlertSeverity.Critical, "🔴 Critical on web-1:")]
    [InlineData(AlertSeverity.Warning, "🟠 Warning on web-1:")]
    [InlineData(AlertSeverity.Info, "🔵 Note on web-1:")]
    public void Each_severity_has_its_own_mark(AlertSeverity severity, string start)
    {
        Assert.StartsWith(start, TelegramMessages.Compose(Alert(severity: severity), "web-1", TelegramChange.Opened), StringComparison.Ordinal);
    }

    [Fact]
    public void A_problem_that_got_worse_says_so()
    {
        var text = TelegramMessages.Compose(Alert(AlertKind.DiskPressure, message: "/ is 96% full"), "web-1", TelegramChange.Worse);

        Assert.Equal("🔴 Now critical on web-1: A disk is nearly full\n/ is 96% full", text);
    }

    [Fact]
    public void A_problem_that_cleared_says_it_is_resolved_and_what_it_was()
    {
        var text = TelegramMessages.Compose(Alert(), "web-1", TelegramChange.Resolved);

        Assert.Equal("✅ Resolved on web-1: A backup failed\nIt was: Nightly DB: the archive could not be built: disk full", text);
    }

    [Theory]
    [InlineData(AlertKind.DiskPressure, AlertSeverity.Warning, "A disk is filling up")]
    [InlineData(AlertKind.DiskPressure, AlertSeverity.Critical, "A disk is nearly full")]
    [InlineData(AlertKind.JobFailed, AlertSeverity.Warning, "A job failed")]
    [InlineData(AlertKind.RebootRequired, AlertSeverity.Warning, "The server needs a reboot")]
    [InlineData(AlertKind.FirewallRolledBack, AlertSeverity.Warning, "A firewall change was rolled back")]
    [InlineData(AlertKind.FirewallRollbackFailed, AlertSeverity.Critical, "A firewall change could not be rolled back")]
    [InlineData(AlertKind.CertificateRenewalFailed, AlertSeverity.Warning, "A certificate did not renew")]
    [InlineData(AlertKind.OriginLockRefreshFailed, AlertSeverity.Warning, "The Cloudflare lock could not be refreshed")]
    [InlineData(AlertKind.BackupFailed, AlertSeverity.Warning, "A backup failed")]
    [InlineData(AlertKind.ContainerCrashLoop, AlertSeverity.Critical, "A container keeps restarting")]
    public void Every_kind_has_a_title(AlertKind kind, AlertSeverity severity, string title)
    {
        Assert.Equal(title, TelegramMessages.Title(kind, severity));
    }

    [Fact]
    public void No_kind_is_left_without_its_own_title()
    {
        Assert.All(Enum.GetValues<AlertKind>(), kind => Assert.NotEqual("Something needs a look", TelegramMessages.Title(kind, AlertSeverity.Warning)));
    }

    [Fact]
    public void A_very_long_message_is_cut_to_what_telegram_takes()
    {
        var text = TelegramMessages.Compose(Alert(message: new string('x', 10_000)), "web-1", TelegramChange.Opened);

        Assert.Equal(TelegramMessages.MaxLength, text.Length);
        Assert.EndsWith("…", text, StringComparison.Ordinal);
    }

    [Fact]
    public void The_test_message_names_the_server_and_who_asked()
    {
        Assert.Equal(
            "✅ Runova test from web-1, sent by maria. Alerts from this server will arrive in this chat.",
            TelegramMessages.Test("web-1", "maria"));
    }
}
