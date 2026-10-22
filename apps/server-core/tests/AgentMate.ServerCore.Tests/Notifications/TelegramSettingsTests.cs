using AgentMate.ServerCore.Contracts;
using AgentMate.ServerCore.Notifications;
using Microsoft.AspNetCore.DataProtection;

namespace AgentMate.ServerCore.Tests.Notifications;

/// <summary>
/// What the core keeps about Telegram notifications: a small root-only file in its state folder,
/// with the bot token sealed so a copy of the file alone cannot send as the bot. A file nobody can
/// read again means "not set up". What a person types is checked before anything is kept.
/// </summary>
public sealed class TelegramSettingsTests : IDisposable
{
    internal const string Token = "7712345678:AAHk3jQx9v2Lw8YtPz5rNc4mBq7sDf1gHjE";

    private readonly string _directory = TestFolders.Create("agentmate-telegram");

    private readonly IDataProtector _protector = new EphemeralDataProtectionProvider().CreateProtector("AgentMate.Notifications.Telegram.Token.v1");

    private string SettingsFile => Path.Combine(_directory, "telegram-notifications.json");

    public void Dispose() => TestFolders.Delete(_directory);

    private static TelegramConfig Config(bool enabled = true, AlertKind[]? kinds = null, bool sendResolved = true) =>
        new(enabled, Token, "-1001234567890", "web-1", kinds ?? TelegramConfig.AllKinds, sendResolved, 1_700_000_000_000, "maria");

    [Fact]
    public void Settings_round_trip()
    {
        var store = new TelegramStore(SettingsFile, _protector);
        var config = Config(enabled: false, kinds: [AlertKind.BackupFailed, AlertKind.DiskPressure], sendResolved: false);

        store.Write(config);

        Assert.Equivalent(config, store.Read(), strict: true);
    }

    [Fact]
    public void Nothing_stored_means_not_set_up()
    {
        Assert.Null(new TelegramStore(SettingsFile, _protector).Read());
    }

    [Fact]
    public void The_file_holds_no_token_in_the_clear()
    {
        new TelegramStore(SettingsFile, _protector).Write(Config());

        var text = File.ReadAllText(SettingsFile);

        Assert.DoesNotContain(Token, text, StringComparison.Ordinal);
        Assert.DoesNotContain("AAHk3jQx9v2Lw8YtPz5rNc4mBq7sDf1gHjE", text, StringComparison.Ordinal);
        Assert.Contains("web-1", text, StringComparison.Ordinal);
    }

    [Fact]
    public void The_file_is_readable_by_its_owner_only()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "Unix file modes");
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        new TelegramStore(SettingsFile, _protector).Write(Config());

        Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(SettingsFile));
    }

    [Fact]
    public void A_file_sealed_with_another_key_or_garbled_reads_as_not_set_up()
    {
        new TelegramStore(SettingsFile, new EphemeralDataProtectionProvider().CreateProtector("other")).Write(Config());
        Assert.Null(new TelegramStore(SettingsFile, _protector).Read());

        File.WriteAllText(SettingsFile, "{ not json");
        Assert.Null(new TelegramStore(SettingsFile, _protector).Read());
    }

    [Fact]
    public void Deleting_forgets_the_settings()
    {
        var store = new TelegramStore(SettingsFile, _protector);
        store.Write(Config());

        store.Delete();

        Assert.Null(store.Read());
        Assert.False(File.Exists(SettingsFile));
    }

    [Theory]
    [InlineData("7712345678:AAHk3jQx9v2Lw8YtPz5rNc4mBq7sDf1gHjE")]
    [InlineData("123:abcdefghijklmnopqrstuvwxyz_-0123")]
    public void A_token_shaped_like_BotFathers_passes(string token)
    {
        Assert.Null(TelegramConfig.TokenProblem(token));
    }

    [Theory]
    [InlineData("")]
    [InlineData("AAHk3jQx9v2Lw8YtPz5rNc4mBq7sDf1gHjE")]
    [InlineData("7712345678:short")]
    [InlineData("7712345678:AAHk3jQx9v2Lw8YtPz5rNc4mBq7sDf1g/jE")]
    [InlineData("bot7712345678:AAHk3jQx9v2Lw8YtPz5rNc4mBq7sDf1gHjE")]
    public void Anything_else_is_not_a_bot_token(string token)
    {
        Assert.Contains("BotFather", TelegramConfig.TokenProblem(token), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("123456789")]
    [InlineData("-1001234567890")]
    [InlineData("-4567890")]
    [InlineData("@agentmate_alerts")]
    [InlineData("  123456789 ")]
    public void A_person_a_group_or_a_channel_is_a_chat(string chat)
    {
        var problems = TelegramConfig.Check(chat, "web-1", null, "box", out var checkedChat, out _, out _);

        Assert.Empty(problems);
        Assert.Equal(chat.Trim(), checkedChat);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("12 34")]
    [InlineData("@ab")]
    [InlineData("https://t.me/agentmate")]
    [InlineData("--123")]
    public void Anything_else_is_not_a_chat(string? chat)
    {
        var problems = TelegramConfig.Check(chat, "web-1", null, "box", out _, out _, out _);

        Assert.Contains(problems, problem => problem.Contains("chat ID", StringComparison.Ordinal));
    }

    [Fact]
    public void An_empty_server_name_is_the_machines_name()
    {
        TelegramConfig.Check("123", "  ", null, "build-box", out _, out var name, out _);

        Assert.Equal("build-box", name);
    }

    [Fact]
    public void A_server_name_is_trimmed_and_kept_short_and_on_one_line()
    {
        Assert.Empty(TelegramConfig.Check("123", "  prod 1 ", null, "box", out _, out var name, out _));
        Assert.Equal("prod 1", name);
        Assert.NotEmpty(TelegramConfig.Check("123", new string('x', TelegramConfig.MaxServerNameLength + 1), null, "box", out _, out _, out _));
        Assert.NotEmpty(TelegramConfig.Check("123", "prod\n1", null, "box", out _, out _, out _));
    }

    [Fact]
    public void Leaving_the_kinds_out_means_every_kind()
    {
        TelegramConfig.Check("123", "web-1", null, "box", out _, out _, out var kinds);

        Assert.Equal(Enum.GetValues<AlertKind>(), kinds);
        Assert.Contains(AlertKind.BackupFailed, kinds);
        Assert.Contains(AlertKind.ContainerCrashLoop, kinds);
    }

    [Fact]
    public void Kinds_are_kept_once_each_in_order_and_unknown_ones_are_refused()
    {
        Assert.Empty(TelegramConfig.Check("123", "web-1", [AlertKind.JobFailed, AlertKind.DiskPressure, AlertKind.JobFailed], "box", out _, out _, out var kinds));
        Assert.Equal([AlertKind.DiskPressure, AlertKind.JobFailed], kinds);

        Assert.Empty(TelegramConfig.Check("123", "web-1", [], "box", out _, out _, out var none));
        Assert.Empty(none);

        Assert.NotEmpty(TelegramConfig.Check("123", "web-1", [(AlertKind)999], "box", out _, out _, out _));
    }
}
