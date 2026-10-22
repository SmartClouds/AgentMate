using System.Net;
using AgentMate.ServerCore.Contracts;
using AgentMate.ServerCore.Notifications;
using AgentMate.ServerCore.Tests.ErrorReporting;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;

namespace AgentMate.ServerCore.Tests.Notifications;

/// <summary>
/// The manager keeps the settings file and what the notifier sends in step: what is saved is what is
/// used at once, it survives a restart, the token can stay while the rest changes, and the status
/// never carries the token.
/// </summary>
public sealed class TelegramManagerTests : IDisposable
{
    private const string Token = TelegramSettingsTests.Token;

    private readonly string _directory = TestFolders.Create("agentmate-telegram-mgr");

    private readonly FakeIngest _telegram = new() { Respond = _ => FakeTelegram.Ok() };

    private readonly FakeTimeProvider _time = new(new DateTimeOffset(2026, 10, 22, 12, 0, 0, TimeSpan.Zero));

    private readonly EphemeralDataProtectionProvider _protection = new();

    private readonly List<IDisposable> _disposables = [];

    public void Dispose()
    {
        foreach (var disposable in _disposables)
        {
            disposable.Dispose();
        }

        TestFolders.Delete(_directory);
    }

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private TelegramManager Create()
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Core:DataDirectory"] = _directory })
            .Build();
        var client = new TelegramBotClient(new FakeTelegramTransport(_telegram), _time);
        _disposables.Add(client);
        var manager = new TelegramManager(configuration, client, _protection, _time, NullLogger<TelegramManager>.Instance, "build-box");
        _disposables.Add(manager);
        return manager;
    }

    private static TelegramNotificationsRequest Request(
        string? token = Token,
        string? chat = "-1001234567890",
        string? serverName = "web-1",
        AlertKind[]? kinds = null,
        bool enabled = true,
        bool sendResolved = true) =>
        new(enabled, token, chat, serverName, kinds, sendResolved);

    [Fact]
    public async Task Before_anything_is_saved_the_status_says_not_set_up_with_every_kind_on()
    {
        var status = await Create().StatusAsync(Cancel);

        Assert.False(status.Configured);
        Assert.False(status.Enabled);
        Assert.Null(status.ChatId);
        Assert.Equal("build-box", status.ServerName);
        Assert.Equal("build-box", status.DefaultServerName);
        Assert.Equal(Enum.GetValues<AlertKind>(), status.Kinds);
        Assert.True(status.SendResolved);
    }

    [Fact]
    public async Task Saving_is_used_at_once_and_the_status_describes_it_without_the_token()
    {
        var manager = Create();

        var saved = await manager.SaveAsync(Request(kinds: [AlertKind.BackupFailed]), "maria", Cancel);

        Assert.Empty(saved.Problems);
        var status = saved.Status!;
        Assert.True(status.Configured);
        Assert.True(status.Enabled);
        Assert.Equal("-1001234567890", status.ChatId);
        Assert.Equal("web-1", status.ServerName);
        Assert.Equal([AlertKind.BackupFailed], status.Kinds);
        Assert.Equal("maria", status.ChangedBy);
        Assert.Equal(_time.GetUtcNow().ToUnixTimeMilliseconds(), status.ChangedAtUnixMs);
        Assert.DoesNotContain(Token, status.ToString(), StringComparison.Ordinal);
        Assert.Equal(Token, manager.Current!.BotToken);
    }

    [Fact]
    public async Task What_is_saved_is_picked_up_again_after_a_restart()
    {
        await Create().SaveAsync(Request(sendResolved: false), "maria", Cancel);

        var again = Create();

        Assert.False((await again.StatusAsync(Cancel)).SendResolved);
        Assert.Equal(Token, again.Current!.BotToken);
    }

    [Fact]
    public async Task Leaving_the_token_out_keeps_the_one_stored()
    {
        var manager = Create();
        await manager.SaveAsync(Request(), "maria", Cancel);

        var saved = await manager.SaveAsync(Request(token: "  ", chat: "123456789"), "maria", Cancel);

        Assert.Empty(saved.Problems);
        Assert.Equal("123456789", saved.Status!.ChatId);
        Assert.Equal(Token, manager.Current!.BotToken);
    }

    [Fact]
    public async Task The_first_setup_needs_a_token_and_wrong_options_save_nothing()
    {
        var manager = Create();

        var noToken = await manager.SaveAsync(Request(token: null), "maria", Cancel);
        var badToken = await manager.SaveAsync(Request(token: "not-a-token"), "maria", Cancel);
        var badChat = await manager.SaveAsync(Request(chat: "someone"), "maria", Cancel);

        Assert.Contains(noToken.Problems, p => p.Contains("BotFather", StringComparison.Ordinal));
        Assert.Contains(badToken.Problems, p => p.Contains("BotFather", StringComparison.Ordinal));
        Assert.Contains(badChat.Problems, p => p.Contains("chat ID", StringComparison.Ordinal));
        Assert.Null(noToken.Status);
        Assert.False((await manager.StatusAsync(Cancel)).Configured);
        Assert.Null(manager.Current);
    }

    [Fact]
    public async Task An_empty_server_name_is_the_machines_name()
    {
        var saved = await Create().SaveAsync(Request(serverName: ""), "maria", Cancel);

        Assert.Equal("build-box", saved.Status!.ServerName);
    }

    [Fact]
    public async Task Removing_forgets_the_token_and_stops_sending()
    {
        var manager = Create();
        await manager.SaveAsync(Request(), "maria", Cancel);

        var status = await manager.RemoveAsync("maria", Cancel);

        Assert.False(status.Configured);
        Assert.Null(manager.Current);
        Assert.False((await Create().StatusAsync(Cancel)).Configured);
    }

    [Fact]
    public async Task A_test_goes_to_the_chat_and_counts_as_sent()
    {
        var manager = Create();
        await manager.SaveAsync(Request(enabled: false), "maria", Cancel);

        var result = await manager.SendTestAsync("maria", Cancel);
        var status = await manager.StatusAsync(Cancel);

        Assert.True(result.Delivered);
        Assert.Contains("Telegram took the test message", result.Message, StringComparison.Ordinal);
        Assert.Contains("AgentMate test from web-1, sent by maria", Assert.Single(_telegram.Requests).Body, StringComparison.Ordinal);
        Assert.Equal(1, status.SentCount);
        Assert.Equal(_time.GetUtcNow().ToUnixTimeMilliseconds(), status.LastSentAtUnixMs);
    }

    [Fact]
    public async Task A_test_before_setup_says_to_set_it_up_and_sends_nothing()
    {
        var result = await Create().SendTestAsync("maria", Cancel);

        Assert.False(result.Delivered);
        Assert.Contains("not set up", result.Message, StringComparison.Ordinal);
        Assert.Empty(_telegram.Requests);
    }

    [Fact]
    public async Task A_failed_send_shows_in_the_status_until_one_goes_through()
    {
        var manager = Create();
        await manager.SaveAsync(Request(), "maria", Cancel);
        _telegram.Respond = _ => FakeTelegram.Error(HttpStatusCode.BadRequest, "Bad Request: chat not found");

        var failed = await manager.SendTestAsync("maria", Cancel);
        var afterFailure = await manager.StatusAsync(Cancel);
        _telegram.Respond = _ => FakeTelegram.Ok();
        await manager.DeliverAsync("hello", Cancel);
        var afterSuccess = await manager.StatusAsync(Cancel);

        Assert.False(failed.Delivered);
        Assert.Contains("cannot find that chat", failed.Message, StringComparison.Ordinal);
        Assert.Contains("cannot find that chat", afterFailure.LastError, StringComparison.Ordinal);
        Assert.NotNull(afterFailure.LastFailedAtUnixMs);
        Assert.Null(afterSuccess.LastError);
        Assert.Equal(1, afterSuccess.SentCount);
    }

    [Fact]
    public async Task Delivering_while_paused_or_not_set_up_sends_nothing()
    {
        var manager = Create();
        Assert.False((await manager.DeliverAsync("hello", Cancel)).Delivered);

        await manager.SaveAsync(Request(enabled: false), "maria", Cancel);
        Assert.False((await manager.DeliverAsync("hello", Cancel)).Delivered);

        Assert.Empty(_telegram.Requests);
    }
}
