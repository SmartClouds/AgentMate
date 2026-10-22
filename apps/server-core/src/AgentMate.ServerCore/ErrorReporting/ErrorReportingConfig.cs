using System.Text.RegularExpressions;

namespace AgentMate.ServerCore.ErrorReporting;

/// <summary>The lowest level of log the core sends to Sentry.</summary>
public enum ReportingLevel
{
    /// <summary>Warnings, errors and critical failures (the default).</summary>
    Warning,

    /// <summary>Errors and critical failures only.</summary>
    Error,
}

internal static class ReportingLevels
{
    public static bool Allows(this ReportingLevel level, LogLevel log) =>
        log >= (level == ReportingLevel.Error ? LogLevel.Error : LogLevel.Warning);

    public static string ToWire(this ReportingLevel level) => level == ReportingLevel.Error ? "error" : "warning";
}

/// <summary>
/// How the core reports to Sentry: where, under which environment and server name, and from which
/// level up. Enabled can be off while the rest is kept, so reporting pauses without losing the DSN.
/// </summary>
internal sealed partial record ErrorReportingConfig(
    bool Enabled,
    SentryDsn Dsn,
    string Environment,
    string ServerName,
    ReportingLevel MinLevel,
    long? ChangedAt = null,
    string? ChangedBy = null)
{
    public const int MaxEnvironmentLength = 64;

    public const int MaxServerNameLength = 128;

    public const string DefaultEnvironment = "production";

    /// <summary>
    /// Checks and tidies the options a person typed. An empty environment is "production" (Sentry's own
    /// default), an empty server name is the machine's name, and an empty level is Warning. The result
    /// lists what is wrong in plain words, so it is empty when the options are fine.
    /// </summary>
    public static string[] Check(
        string? environment,
        string? serverName,
        string? level,
        string machineName,
        out string checkedEnvironment,
        out string checkedServerName,
        out ReportingLevel checkedLevel)
    {
        var problems = new List<string>();

        checkedEnvironment = environment?.Trim() is { Length: > 0 } env ? env : DefaultEnvironment;
        if (!EnvironmentShape().IsMatch(checkedEnvironment))
        {
            problems.Add($"Environment can only use letters, digits, dots, dashes and underscores, up to {MaxEnvironmentLength} characters.");
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

        checkedLevel = ReportingLevel.Warning;
        switch (level?.Trim().ToLowerInvariant())
        {
            case null or "" or "warning":
                break;
            case "error":
                checkedLevel = ReportingLevel.Error;
                break;
            default:
                problems.Add("The level must be Warning (warnings and errors) or Error (errors only).");
                break;
        }

        return [.. problems];
    }

    [GeneratedRegex("^[A-Za-z0-9._-]{1,64}$", RegexOptions.CultureInvariant)]
    private static partial Regex EnvironmentShape();
}
