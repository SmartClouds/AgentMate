using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.Notifications;

/// <summary>
/// The Telegram settings as a small file in the core's own state folder (root only), like the error
/// reporting settings. The bot token is sealed with Data Protection, so a copy of the file alone cannot
/// send as the bot. A file that cannot be read back reads as "not set up": better silent than guessing.
/// </summary>
internal sealed class TelegramStore(string path, IDataProtector protector)
{
    public TelegramConfig? Read()
    {
        if (!File.Exists(path))
        {
            return null;
        }

        try
        {
            var stored = JsonSerializer.Deserialize<Stored>(File.ReadAllText(path), CoreJson.Options);
            if (stored is null)
            {
                return null;
            }

            var token = protector.Unprotect(stored.BotToken);
            var problems = TelegramConfig.Check(stored.ChatId, stored.ServerName, stored.Kinds, string.Empty, out var chat, out var serverName, out var kinds);
            return problems.Length > 0 || serverName.Length == 0 || TelegramConfig.TokenProblem(token) is not null
                ? null
                : new TelegramConfig(stored.Enabled, token, chat, serverName, kinds, stored.SendResolved, stored.ChangedAt, stored.ChangedBy);
        }
        catch (Exception problem) when (problem is JsonException or CryptographicException or IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    public void Write(TelegramConfig config)
    {
        ArgumentNullException.ThrowIfNull(config);
        var directory = Path.GetDirectoryName(path)!;
        Directory.CreateDirectory(directory);
        var temporary = $"{path}.{Guid.NewGuid():N}.tmp";
        var stored = new Stored(
            config.Enabled,
            protector.Protect(config.BotToken),
            config.ChatId,
            config.ServerName,
            config.Kinds,
            config.SendResolved,
            config.ChangedAt,
            config.ChangedBy);
        File.WriteAllText(temporary, JsonSerializer.Serialize(stored, CoreJson.Options));
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(temporary, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }

        File.Move(temporary, path, overwrite: true);
    }

    public void Delete()
    {
        if (File.Exists(path))
        {
            File.Delete(path);
        }
    }

    private sealed record Stored(
        bool Enabled,
        string BotToken,
        string ChatId,
        string ServerName,
        AlertKind[] Kinds,
        bool SendResolved,
        long? ChangedAt,
        string? ChangedBy);
}
