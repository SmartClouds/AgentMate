using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;

namespace Runova.ServerCore.ErrorReporting;

/// <summary>
/// The error reporting settings as a small file in the core's own state folder (root only), like the
/// direct TLS settings. The DSN is sealed with Data Protection, so a copy of the file alone holds no key.
/// A file that cannot be read back reads as "not set up": better silent than guessing where logs go.
/// </summary>
internal sealed class ErrorReportingStore(string path, IDataProtector protector)
{
    public ErrorReportingConfig? Read()
    {
        if (!File.Exists(path))
        {
            return null;
        }

        try
        {
            var stored = JsonSerializer.Deserialize<Stored>(File.ReadAllText(path), CoreJson.Options);
            if (stored is null || !SentryDsn.TryParse(protector.Unprotect(stored.Dsn), out var dsn, out _))
            {
                return null;
            }

            var problems = ErrorReportingConfig.Check(stored.Environment, stored.ServerName, stored.MinLevel, string.Empty, out var environment, out var serverName, out var level);
            return problems.Length > 0 || serverName.Length == 0
                ? null
                : new ErrorReportingConfig(stored.Enabled, dsn, environment, serverName, level, stored.ChangedAt, stored.ChangedBy);
        }
        catch (Exception problem) when (problem is JsonException or CryptographicException or IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    public void Write(ErrorReportingConfig config)
    {
        ArgumentNullException.ThrowIfNull(config);
        var directory = Path.GetDirectoryName(path)!;
        Directory.CreateDirectory(directory);
        var temporary = $"{path}.{Guid.NewGuid():N}.tmp";
        var stored = new Stored(
            config.Enabled,
            protector.Protect(config.Dsn.ToSecretString()),
            config.Environment,
            config.ServerName,
            config.MinLevel.ToWire(),
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

    private sealed record Stored(bool Enabled, string Dsn, string Environment, string ServerName, string MinLevel, long? ChangedAt, string? ChangedBy);
}
