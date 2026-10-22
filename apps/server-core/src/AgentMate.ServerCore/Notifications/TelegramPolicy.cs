using AgentMate.ServerCore.Contracts;

namespace AgentMate.ServerCore.Notifications;

/// <summary>
/// Decides whether a change to an alert is worth a message. Alerts change often (a full disk is raised
/// again every minute), but a person wants to hear when something opens, when it gets worse, and when
/// it clears, and nothing in between.
/// </summary>
internal static class TelegramPolicy
{
    /// <param name="change">The alert as it is after the change.</param>
    /// <param name="announced">
    /// The highest severity a message went out for while this alert has been open, or null when nobody
    /// was told about it.
    /// </param>
    /// <param name="config">The settings, or null when Telegram is not set up.</param>
    public static TelegramChange? Decide(AlertInfo change, AlertSeverity? announced, TelegramConfig? config)
    {
        ArgumentNullException.ThrowIfNull(change);
        if (config is not { Enabled: true } || !config.Kinds.Contains(change.Kind))
        {
            return null;
        }

        if (change.ResolvedAtUnixMs is not null)
        {
            return announced is not null && config.SendResolved ? TelegramChange.Resolved : null;
        }

        if (announced is not AlertSeverity told)
        {
            return TelegramChange.Opened;
        }

        return change.Severity > told ? TelegramChange.Worse : null;
    }
}
