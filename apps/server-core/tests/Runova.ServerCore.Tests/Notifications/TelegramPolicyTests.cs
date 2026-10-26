using Runova.ServerCore.Contracts;
using Runova.ServerCore.Notifications;

namespace Runova.ServerCore.Tests.Notifications;

/// <summary>
/// When a change to an alert is worth a message: when it opens, when it gets worse, and (if asked for)
/// when it clears after a message about it went out. Never for a repeat or an acknowledgment, never for
/// a kind that was turned off, and never while sending is paused.
/// </summary>
public sealed class TelegramPolicyTests
{
    private static TelegramConfig Config(bool enabled = true, AlertKind[]? kinds = null, bool sendResolved = true) =>
        new(enabled, TelegramSettingsTests.Token, "123", "web-1", kinds ?? TelegramConfig.AllKinds, sendResolved);

    private static AlertInfo Alert(
        AlertSeverity severity = AlertSeverity.Warning,
        int occurrences = 1,
        long? resolvedAt = null,
        long? acknowledgedAt = null,
        AlertKind kind = AlertKind.DiskPressure) =>
        new(1, 1, kind, severity, "/", "/ is 91% full", 1_000, 1_000, occurrences, acknowledgedAt, acknowledgedAt is null ? null : "maria", resolvedAt);

    [Fact]
    public void A_new_alert_of_a_chosen_kind_is_sent()
    {
        Assert.Equal(TelegramChange.Opened, TelegramPolicy.Decide(Alert(), announced: null, Config()));
    }

    [Fact]
    public void A_kind_that_was_turned_off_is_not_sent()
    {
        Assert.Null(TelegramPolicy.Decide(Alert(), announced: null, Config(kinds: [AlertKind.BackupFailed])));
    }

    [Fact]
    public void Nothing_is_sent_while_sending_is_paused_or_not_set_up()
    {
        Assert.Null(TelegramPolicy.Decide(Alert(), announced: null, Config(enabled: false)));
        Assert.Null(TelegramPolicy.Decide(Alert(), announced: null, config: null));
    }

    [Fact]
    public void The_same_problem_again_is_not_sent_again()
    {
        Assert.Null(TelegramPolicy.Decide(Alert(occurrences: 5), announced: AlertSeverity.Warning, Config()));
    }

    [Fact]
    public void Getting_worse_is_sent_and_getting_better_is_not()
    {
        Assert.Equal(TelegramChange.Worse, TelegramPolicy.Decide(Alert(AlertSeverity.Critical, 2), AlertSeverity.Warning, Config()));
        Assert.Null(TelegramPolicy.Decide(Alert(AlertSeverity.Warning, 3), AlertSeverity.Critical, Config()));
    }

    [Fact]
    public void An_acknowledgment_on_its_own_is_not_sent()
    {
        Assert.Null(TelegramPolicy.Decide(Alert(acknowledgedAt: 2_000), AlertSeverity.Warning, Config()));
    }

    [Fact]
    public void Clearing_is_sent_when_a_message_about_it_went_out_and_resolved_notes_are_on()
    {
        Assert.Equal(TelegramChange.Resolved, TelegramPolicy.Decide(Alert(resolvedAt: 3_000), AlertSeverity.Warning, Config()));
        Assert.Null(TelegramPolicy.Decide(Alert(resolvedAt: 3_000), AlertSeverity.Warning, Config(sendResolved: false)));
    }

    [Fact]
    public void Clearing_a_problem_nobody_was_told_about_is_not_sent()
    {
        Assert.Null(TelegramPolicy.Decide(Alert(resolvedAt: 3_000), announced: null, Config()));
    }

    [Fact]
    public void Clearing_is_not_sent_for_a_kind_turned_off_since()
    {
        Assert.Null(TelegramPolicy.Decide(Alert(resolvedAt: 3_000), AlertSeverity.Warning, Config(kinds: [AlertKind.JobFailed])));
    }
}
