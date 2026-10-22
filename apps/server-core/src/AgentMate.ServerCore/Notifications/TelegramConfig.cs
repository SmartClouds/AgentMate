using System.Text.RegularExpressions;
using AgentMate.ServerCore.Contracts;

namespace AgentMate.ServerCore.Notifications;

/// <summary>
/// Where the core sends its alerts on Telegram (E30): which bot, which chat (a person, a group or a
/// channel), the name that starts every message, which kinds of alert, and whether a note follows when
/// a problem clears. Enabled can be off while the rest is kept, so sending pauses without losing the token.
/// </summary>
internal sealed partial record TelegramConfig(
    bool Enabled,
    string BotToken,
    string ChatId,
    string ServerName,
    AlertKind[] Kinds,
    bool SendResolved,
    long? ChangedAt = null,
    string? ChangedBy = null)
{
    public const int MaxServerNameLength = 64;

    /// <summary>Every kind of alert, in the order they are declared: what a new setup sends.</summary>
    public static AlertKind[] AllKinds => Enum.GetValues<AlertKind>();

    /// <summary>Null when the token looks like one BotFather hands out; otherwise what is wrong, in words.</summary>
    public static string? TokenProblem(string token) =>
        BotTokenShape().IsMatch(token)
            ? null
            : "That does not look like a bot token. BotFather gives one shaped like 123456789:AAH... when you create the bot.";

    /// <summary>
    /// Checks and tidies the options a person typed. An empty server name is the machine's name and
    /// leaving the kinds out means every kind. The result lists what is wrong in plain words, so it is
    /// empty when the options are fine.
    /// </summary>
    public static string[] Check(
        string? chatId,
        string? serverName,
        AlertKind[]? kinds,
        string machineName,
        out string checkedChatId,
        out string checkedServerName,
        out AlertKind[] checkedKinds)
    {
        var problems = new List<string>();

        checkedChatId = chatId?.Trim() ?? string.Empty;
        if (!ChatShape().IsMatch(checkedChatId))
        {
            problems.Add("Enter the chat ID of the person or group: a number such as 123456789 or -1001234567890, or a channel's @name.");
        }

        checkedServerName = serverName?.Trim() is { Length: > 0 } name ? name : machineName;
        if (checkedServerName.Length > MaxServerNameLength)
        {
            problems.Add($"Server name is too long ({MaxServerNameLength} characters at most).");
        }
        else if (checkedServerName.Any(char.IsControl))
        {
            problems.Add("Server name cannot hold line breaks, tabs or other control characters.");
        }

        var chosen = kinds ?? AllKinds;
        if (chosen.Any(kind => !Enum.IsDefined(kind)))
        {
            problems.Add("One of the chosen alert kinds is not one this server knows. Update the app, then try again.");
        }

        checkedKinds = [.. AllKinds.Where(chosen.Contains)];
        return [.. problems];
    }

    [GeneratedRegex(@"^\d{1,20}:[A-Za-z0-9_-]{30,}$", RegexOptions.CultureInvariant)]
    private static partial Regex BotTokenShape();

    [GeneratedRegex(@"^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$", RegexOptions.CultureInvariant)]
    private static partial Regex ChatShape();
}
