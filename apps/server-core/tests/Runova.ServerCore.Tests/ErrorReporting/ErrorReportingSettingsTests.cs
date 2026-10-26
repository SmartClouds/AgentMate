using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Logging;
using Runova.ServerCore.ErrorReporting;

namespace Runova.ServerCore.Tests.ErrorReporting;

/// <summary>
/// What the core keeps about error reporting: a small root-only file in its state folder, with the DSN
/// sealed so a copy of the file alone reveals no key. A file nobody can read again means "off".
/// </summary>
public sealed class ErrorReportingSettingsTests : IDisposable
{
    private const string Key = "d4e5f60718293a4b5c6d7e8f90a1b2c3";

    private readonly string _directory = Path.Combine(Path.GetTempPath(), $"runova-error-reporting-{Guid.NewGuid():N}");

    private readonly IDataProtector _protector = new EphemeralDataProtectionProvider().CreateProtector("Runova.ErrorReporting.Dsn.v1");

    private string SettingsFile => Path.Combine(_directory, "error-reporting.json");

    public void Dispose() => TestFolders.Delete(_directory);

    private static ErrorReportingConfig Config(bool enabled = true, ReportingLevel level = ReportingLevel.Warning)
    {
        Assert.True(SentryDsn.TryParse($"https://{Key}@o1.ingest.sentry.io/42", out var dsn, out _));
        return new ErrorReportingConfig(enabled, dsn!, "production", "web-1", level, 1_700_000_000_000, "maria");
    }

    [Fact]
    public void Settings_round_trip()
    {
        var store = new ErrorReportingStore(SettingsFile, _protector);
        var config = Config(enabled: false, level: ReportingLevel.Error);

        store.Write(config);

        Assert.Equal(config, store.Read());
    }

    [Fact]
    public void Nothing_stored_means_not_set_up()
    {
        Assert.Null(new ErrorReportingStore(SettingsFile, _protector).Read());
    }

    [Fact]
    public void The_file_holds_no_key_in_the_clear()
    {
        new ErrorReportingStore(SettingsFile, _protector).Write(Config());

        var text = File.ReadAllText(SettingsFile);

        Assert.DoesNotContain(Key, text, StringComparison.Ordinal);
        Assert.Contains("web-1", text, StringComparison.Ordinal);
    }

    [Fact]
    public void The_file_is_readable_by_its_owner_only()
    {
        new ErrorReportingStore(SettingsFile, _protector).Write(Config());

        if (!OperatingSystem.IsWindows())
        {
            Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(SettingsFile));
        }
    }

    [Fact]
    public void Writing_again_replaces_the_file_and_leaves_no_temporary_one_behind()
    {
        var store = new ErrorReportingStore(SettingsFile, _protector);

        store.Write(Config(level: ReportingLevel.Warning));
        store.Write(Config(level: ReportingLevel.Error));

        Assert.Equal(ReportingLevel.Error, store.Read()!.MinLevel);
        Assert.Equal(["error-reporting.json"], Directory.GetFiles(_directory).Select(Path.GetFileName));
    }

    [Fact]
    public void An_unreadable_file_means_off_rather_than_a_guess()
    {
        var store = new ErrorReportingStore(SettingsFile, _protector);
        store.Write(Config());

        File.WriteAllText(SettingsFile, "{ not json");

        Assert.Null(store.Read());
    }

    [Fact]
    public void A_dsn_sealed_by_other_keys_means_off()
    {
        new ErrorReportingStore(SettingsFile, _protector).Write(Config());
        var otherKeys = new EphemeralDataProtectionProvider().CreateProtector("Runova.ErrorReporting.Dsn.v1");

        Assert.Null(new ErrorReportingStore(SettingsFile, otherKeys).Read());
    }

    [Fact]
    public void Removing_deletes_the_file_and_is_fine_when_there_is_none()
    {
        var store = new ErrorReportingStore(SettingsFile, _protector);

        store.Delete();
        store.Write(Config());
        store.Delete();

        Assert.False(File.Exists(SettingsFile));
        Assert.Null(store.Read());
    }

    [Fact]
    public void Printing_the_settings_never_shows_the_key()
    {
        Assert.DoesNotContain(Key, Config().ToString(), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(null, null, null, "production", "host-name", ReportingLevel.Warning)]
    [InlineData("", " ", "", "production", "host-name", ReportingLevel.Warning)]
    [InlineData(" staging ", " web-1 ", "error", "staging", "web-1", ReportingLevel.Error)]
    [InlineData("Prod.eu_1-a", "db server (eu)", "Warning", "Prod.eu_1-a", "db server (eu)", ReportingLevel.Warning)]
    public void Options_are_tidied_and_given_defaults(string? environment, string? serverName, string? level, string expectedEnvironment, string expectedServer, ReportingLevel expectedLevel)
    {
        var problems = ErrorReportingConfig.Check(environment, serverName, level, "host-name", out var checkedEnvironment, out var checkedServer, out var checkedLevel);

        Assert.Empty(problems);
        Assert.Equal(expectedEnvironment, checkedEnvironment);
        Assert.Equal(expectedServer, checkedServer);
        Assert.Equal(expectedLevel, checkedLevel);
    }

    [Theory]
    [InlineData("pro duction", null, null, "Environment")]
    [InlineData("prod/eu", null, null, "Environment")]
    [InlineData("a-very-long-environment-name-that-goes-on-and-on-past-the-sixty-four-limit", null, null, "Environment")]
    [InlineData(null, "line\nbreak", null, "Server name")]
    [InlineData(null, "tab\tname", null, "Server name")]
    [InlineData(null, "x", "info", "level")]
    [InlineData(null, "x", "debug", "level")]
    public void Bad_options_are_refused_in_plain_words(string? environment, string? serverName, string? level, string expected)
    {
        var problems = ErrorReportingConfig.Check(environment, serverName, level, "host-name", out _, out _, out _);

        Assert.Contains(problems, problem => problem.Contains(expected, StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void A_long_server_name_is_refused()
    {
        var problems = ErrorReportingConfig.Check(null, new string('a', ErrorReportingConfig.MaxServerNameLength + 1), null, "host-name", out _, out _, out _);

        Assert.Contains(problems, problem => problem.Contains("Server name", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData(ReportingLevel.Warning, LogLevel.Information, false)]
    [InlineData(ReportingLevel.Warning, LogLevel.Warning, true)]
    [InlineData(ReportingLevel.Warning, LogLevel.Critical, true)]
    [InlineData(ReportingLevel.Error, LogLevel.Warning, false)]
    [InlineData(ReportingLevel.Error, LogLevel.Error, true)]
    [InlineData(ReportingLevel.Error, LogLevel.Critical, true)]
    public void A_level_lets_through_its_own_logs_and_worse(ReportingLevel level, LogLevel log, bool sent)
    {
        Assert.Equal(sent, level.Allows(log));
    }
}
