using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using Runova.ServerCore.Alerts;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Notifications;
using Runova.ServerCore.Security;
using Runova.ServerCore.Tests.ErrorReporting;

namespace Runova.ServerCore.Tests.Notifications;

/// <summary>
/// The notifier listens to the alert center and tells the chat when a problem opens, gets worse or
/// clears: once each, following the settings as they are now, and without losing changes when it falls
/// behind. Problems that were already open when the core started are not sent again.
/// </summary>
public sealed class TelegramNotifierTests : IAsyncLifetime
{
    private readonly string _directory = TestFolders.Create("runova-telegram-notifier");

    private readonly FakeIngest _telegram = new() { Respond = _ => FakeTelegram.Ok() };

    private readonly FakeTimeProvider _time = new(DateTimeOffset.FromUnixTimeMilliseconds(1_800_000_000_000));

    private TestDatabase _database = null!;

    private AlertCenter _alerts = null!;

    private TelegramBotClient _client = null!;

    private TelegramManager _manager = null!;

    private TelegramNotifier? _notifier;

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        _database = await TestDatabase.CreateAsync();
        _alerts = new AlertCenter(_database.Contexts, _time, new Redactor(), NullLogger<AlertCenter>.Instance);
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Core:DataDirectory"] = _directory })
            .Build();
        _client = new TelegramBotClient(new FakeTelegramTransport(_telegram), _time);
        _manager = new TelegramManager(configuration, _client, new EphemeralDataProtectionProvider(), _time, NullLogger<TelegramManager>.Instance, "build-box");
    }

    public async ValueTask DisposeAsync()
    {
        if (_notifier is not null)
        {
            await _notifier.StopAsync(CancellationToken.None);
            _notifier.Dispose();
        }

        _manager.Dispose();
        _client.Dispose();
        _alerts.Dispose();
        await _database.DisposeAsync();
        TestFolders.Delete(_directory);
    }

    private async Task SetUpAsync(AlertKind[]? kinds = null, bool sendResolved = true, bool enabled = true)
    {
        var saved = await _manager.SaveAsync(
            new TelegramNotificationsRequest(enabled, TelegramSettingsTests.Token, "123", "web-1", kinds, sendResolved),
            "maria",
            Cancel);
        Assert.Empty(saved.Problems);
    }

    private async Task StartAsync()
    {
        _notifier = new TelegramNotifier(_alerts, _manager, NullLogger<TelegramNotifier>.Instance);
        await _notifier.StartAsync(Cancel);
        await _notifier.Listening.WaitAsync(TimeSpan.FromSeconds(10), Cancel);
    }

    /// <summary>The text of every message the fake Telegram received, in order.</summary>
    private List<string> Texts =>
        [.. _telegram.Requests.Select(request =>
        {
            using var body = JsonDocument.Parse(Encoding.Latin1.GetBytes(request.Body));
            return body.RootElement.GetProperty("text").GetString()!;
        })];

    private async Task WaitForMessagesAsync(int count)
    {
        for (var i = 0; i < 1_000 && _telegram.Requests.Count < count; i++)
        {
            await Task.Delay(10, Cancel);
        }

        Assert.Equal(count, _telegram.Requests.Count);
    }

    /// <summary>Lets the notifier work through what it has, then checks nothing more went out.</summary>
    private async Task AssertStillAsync(int count)
    {
        await Task.Delay(200, Cancel);
        Assert.Equal(count, _telegram.Requests.Count);
    }

    private Task<AlertInfo> RaiseDiskAsync(AlertSeverity severity = AlertSeverity.Warning, string resource = "/") =>
        _alerts.RaiseAsync(AlertKind.DiskPressure, resource, severity, $"{resource} is 91% full", Cancel);

    [Fact]
    public async Task A_new_problem_is_sent_once_however_often_it_is_raised_again()
    {
        await SetUpAsync();
        await StartAsync();

        await RaiseDiskAsync();
        await WaitForMessagesAsync(1);
        await RaiseDiskAsync();
        await RaiseDiskAsync();

        await AssertStillAsync(1);
        Assert.StartsWith("🟠 Warning on web-1: A disk is filling up\n/ is 91% full", Texts[0], StringComparison.Ordinal);
    }

    [Fact]
    public async Task Getting_worse_and_clearing_each_send_one_more_message()
    {
        await SetUpAsync();
        await StartAsync();

        await RaiseDiskAsync();
        await WaitForMessagesAsync(1);
        await RaiseDiskAsync(AlertSeverity.Critical);
        await WaitForMessagesAsync(2);
        await _alerts.ResolveAsync(AlertKind.DiskPressure, "/", Cancel);
        await WaitForMessagesAsync(3);

        Assert.StartsWith("🔴 Now critical on web-1: A disk is nearly full", Texts[1], StringComparison.Ordinal);
        Assert.StartsWith("✅ Resolved on web-1:", Texts[2], StringComparison.Ordinal);
    }

    [Fact]
    public async Task An_acknowledgment_sends_nothing()
    {
        await SetUpAsync();
        await StartAsync();

        var raised = await RaiseDiskAsync();
        await WaitForMessagesAsync(1);
        await _alerts.AcknowledgeAsync(raised.Id, Guid.NewGuid(), "maria", Cancel);

        await AssertStillAsync(1);
    }

    [Fact]
    public async Task Changing_the_settings_while_running_applies_to_the_next_alert()
    {
        await SetUpAsync();
        await StartAsync();

        await SetUpAsync(kinds: [AlertKind.BackupFailed]);
        await RaiseDiskAsync();
        await AssertStillAsync(0);

        await _alerts.RaiseAsync(AlertKind.BackupFailed, "backup-plan:1", AlertSeverity.Critical, "Nightly failed", Cancel);
        await WaitForMessagesAsync(1);
        Assert.Contains("A backup failed", Texts[0], StringComparison.Ordinal);
    }

    [Fact]
    public async Task Nothing_is_sent_while_paused()
    {
        await SetUpAsync(enabled: false);
        await StartAsync();

        await RaiseDiskAsync();

        await AssertStillAsync(0);
    }

    [Fact]
    public async Task Problems_open_before_the_start_are_not_sent_again_but_their_clearing_is()
    {
        await SetUpAsync();
        await RaiseDiskAsync();
        await StartAsync();

        await RaiseDiskAsync();
        await AssertStillAsync(0);
        await _alerts.ResolveAsync(AlertKind.DiskPressure, "/", Cancel);

        await WaitForMessagesAsync(1);
        Assert.StartsWith("✅ Resolved on web-1:", Texts[0], StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_message_telegram_refused_shows_in_the_status_and_the_next_raise_tries_again()
    {
        await SetUpAsync();
        await StartAsync();
        _telegram.Respond = _ => FakeTelegram.Error(HttpStatusCode.Forbidden, "Forbidden: bot was blocked by the user");

        await RaiseDiskAsync();
        await WaitForMessagesAsync(1);
        await AssertStillAsync(1);
        _telegram.Respond = _ => FakeTelegram.Ok();
        await RaiseDiskAsync();
        await WaitForMessagesAsync(2);

        var status = await _manager.StatusAsync(Cancel);
        Assert.Null(status.LastError);
        Assert.Equal(1, status.SentCount);
        Assert.Equal(Texts[0], Texts[1]);
    }

    [Fact]
    public async Task Falling_behind_loses_no_problem()
    {
        await SetUpAsync();
        await StartAsync();
        using var release = new ManualResetEventSlim();
        _telegram.Respond = _ =>
        {
            release.Wait(TimeSpan.FromSeconds(20));
            return FakeTelegram.Ok();
        };

        var count = AlertCenter.SubscriberBuffer + 50;
        for (var i = 0; i < count; i++)
        {
            await RaiseDiskAsync(resource: $"/mnt/{i}");
        }

        release.Set();

        await WaitForMessagesAsync(count);
        Assert.Equal(count, Texts.Distinct().Count());
    }
}
