using Tapper;

namespace Runova.ServerCore.Contracts;

// Telegram notifications (E30): the core sends its alerts to a Telegram chat through a bot, whether
// or not the app is open. A person gives the server a bot token and a chat; the core keeps the token
// sealed, never returns it, and applies changes at once with no restart.

/// <summary>
/// How Telegram notifications stand. ChatId is the person, group or channel messages go to; ServerName
/// starts every message; Kinds are the alerts that are sent; SendResolved adds a note when one clears.
/// Times are Unix milliseconds. LastError is the last thing that went wrong when sending, in words for
/// a person, until the next message goes through. DefaultServerName is the machine's own name.
/// The token is never part of it.
/// </summary>
[TranspilationSource]
public sealed record TelegramNotificationsStatus(
    bool Configured,
    bool Enabled,
    string? ChatId,
    string ServerName,
    string DefaultServerName,
    AlertKind[] Kinds,
    bool SendResolved,
    long SentCount,
    long? LastSentAtUnixMs = null,
    long? LastFailedAtUnixMs = null,
    string? LastError = null,
    long? ChangedAtUnixMs = null,
    string? ChangedBy = null);

/// <summary>
/// Sets Telegram notifications up (Owner, with a step-up). Leave BotToken out to keep the one already
/// stored, so the chat or the kinds can change without pasting the token again. An empty ServerName
/// means the machine's name, and leaving Kinds out means every kind.
/// </summary>
[TranspilationSource]
public sealed record TelegramNotificationsRequest(
    bool Enabled,
    string? BotToken,
    string? ChatId,
    string? ServerName,
    AlertKind[]? Kinds,
    bool SendResolved)
{
    public override string ToString() =>
        $"TelegramNotificationsRequest {{ Enabled = {Enabled}, BotToken = {(string.IsNullOrWhiteSpace(BotToken) ? "[none]" : "[redacted]")}, ChatId = {ChatId}, ServerName = {ServerName}, Kinds = [{string.Join(", ", Kinds ?? [])}], SendResolved = {SendResolved} }}";
}

/// <summary>Saved when Problems is empty (Status then says how it stands); otherwise nothing was saved.</summary>
[TranspilationSource]
public sealed record TelegramNotificationsSaveResult(string[] Problems, TelegramNotificationsStatus? Status = null);

/// <summary>The outcome of a test message. Delivered says Telegram took it; Message says what happened in words for a person.</summary>
[TranspilationSource]
public sealed record TelegramNotificationsTestResult(bool Delivered, string Message);
