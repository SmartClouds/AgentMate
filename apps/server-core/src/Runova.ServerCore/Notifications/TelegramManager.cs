using Microsoft.AspNetCore.DataProtection;
using Runova.ServerCore.Compatibility;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Hosting;

namespace Runova.ServerCore.Notifications;

/// <summary>
/// Keeps the settings file and what the notifier sends in step. What is saved is used at once, it is
/// picked up again after a restart, and the token stays inside: the status only says which chat.
/// How sending went is kept in memory only, so it starts over when the core does.
/// </summary>
internal sealed partial class TelegramManager(
    IConfiguration configuration,
    TelegramBotClient client,
    IDataProtectionProvider protection,
    TimeProvider time,
    ILogger<TelegramManager> logger,
    string? machineName = null) : IDisposable
{
    private const string SettingsFile = "telegram-notifications.json";

    private readonly SemaphoreSlim _gate = new(1, 1);

    private readonly Lock _deliveryGate = new();

    private readonly Lazy<TelegramStore> _store = new(() => new TelegramStore(
        Path.Combine(CorePaths.DataDirectory(configuration, OperatingSystem.IsLinux()), SettingsFile),
        protection.CreateProtector(FrozenIdentifiers.TelegramTokenPurpose)));

    private TelegramConfig? _current;

    private bool _loaded;

    private Delivery _delivery = Delivery.None;

    private string MachineName => machineName ?? Environment.MachineName;

    private long Now => time.GetUtcNow().ToUnixTimeMilliseconds();

    /// <summary>The settings in use, or null when Telegram is not set up. Read once from the file, then kept.</summary>
    public TelegramConfig? Current
    {
        get
        {
            if (!Volatile.Read(ref _loaded))
            {
                _gate.Wait();
                try
                {
                    Load();
                }
                finally
                {
                    _gate.Release();
                }
            }

            return Volatile.Read(ref _current);
        }
    }

    public void Dispose() => _gate.Dispose();

    public async Task<TelegramNotificationsStatus> StatusAsync(CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            Load();
            return Describe(_current);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<TelegramNotificationsSaveResult> SaveAsync(TelegramNotificationsRequest? request, string changedBy, CancellationToken cancellationToken)
    {
        if (request is null)
        {
            return new TelegramNotificationsSaveResult(["There was nothing to save."]);
        }

        await _gate.WaitAsync(cancellationToken);
        try
        {
            Load();
            var problems = new List<string>();

            string? token = null;
            if (string.IsNullOrWhiteSpace(request.BotToken))
            {
                token = _current?.BotToken;
                if (token is null)
                {
                    problems.Add("Paste the bot token BotFather gave you when you created the bot.");
                }
            }
            else if (TelegramConfig.TokenProblem(request.BotToken.Trim()) is { } tokenProblem)
            {
                problems.Add(tokenProblem);
            }
            else
            {
                token = request.BotToken.Trim();
            }

            problems.AddRange(TelegramConfig.Check(request.ChatId, request.ServerName, request.Kinds, MachineName, out var chat, out var serverName, out var kinds));
            if (problems.Count > 0 || token is null)
            {
                return new TelegramNotificationsSaveResult([.. problems]);
            }

            var config = new TelegramConfig(request.Enabled, token, chat, serverName, kinds, request.SendResolved, Now, changedBy);
            _store.Value.Write(config);
            Volatile.Write(ref _current, config);
            return new TelegramNotificationsSaveResult([], Describe(config));
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<TelegramNotificationsStatus> RemoveAsync(string changedBy, CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            _store.Value.Delete();
            Volatile.Write(ref _current, null);
            _loaded = true;
            lock (_deliveryGate)
            {
                _delivery = Delivery.None;
            }

            LogRemoved(logger, changedBy);
            return Describe(null);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Sends a test message to the chat, paused or not: asking for one is asking to send.</summary>
    public async Task<TelegramNotificationsTestResult> SendTestAsync(string requestedBy, CancellationToken cancellationToken)
    {
        if (Current is not { } config)
        {
            return new TelegramNotificationsTestResult(false, "Telegram is not set up on this server yet.");
        }

        var result = await SendAsync(config, TelegramMessages.Test(config.ServerName, requestedBy), cancellationToken);
        return result.Delivered
            ? new TelegramNotificationsTestResult(true, "Telegram took the test message. It should be in the chat now.")
            : new TelegramNotificationsTestResult(false, result.Error ?? "Telegram did not take the test message.");
    }

    /// <summary>Sends one message with the settings in use. Nothing goes out while Telegram is paused or not set up.</summary>
    public Task<TelegramSendResult> DeliverAsync(string text, CancellationToken cancellationToken) =>
        Current is { Enabled: true } config
            ? SendAsync(config, text, cancellationToken)
            : Task.FromResult(new TelegramSendResult(false, null, "Telegram is paused or not set up."));

    private async Task<TelegramSendResult> SendAsync(TelegramConfig config, string text, CancellationToken cancellationToken)
    {
        var result = await client.SendAsync(config.BotToken, config.ChatId, text, cancellationToken);
        lock (_deliveryGate)
        {
            _delivery = result.Delivered
                ? _delivery with { SentCount = _delivery.SentCount + 1, LastSentAt = Now, LastError = null }
                : _delivery with { LastFailedAt = Now, LastError = result.Error };
        }

        if (!result.Delivered)
        {
            LogNotDelivered(logger, result.Error ?? "no answer");
        }

        return result;
    }

    /// <summary>Under the gate.</summary>
    private void Load()
    {
        if (_loaded)
        {
            return;
        }

        try
        {
            Volatile.Write(ref _current, _store.Value.Read());
        }
#pragma warning disable CA1031 // Notifications are a courtesy: nothing about their settings may stop the core.
        catch (Exception problem)
#pragma warning restore CA1031
        {
            LogLoadFailed(logger, problem);
        }

        Volatile.Write(ref _loaded, true);
    }

    private TelegramNotificationsStatus Describe(TelegramConfig? config)
    {
        Delivery delivery;
        lock (_deliveryGate)
        {
            delivery = _delivery;
        }

        if (config is null)
        {
            return new TelegramNotificationsStatus(
                Configured: false,
                Enabled: false,
                ChatId: null,
                ServerName: MachineName,
                DefaultServerName: MachineName,
                Kinds: TelegramConfig.AllKinds,
                SendResolved: true,
                SentCount: 0);
        }

        return new TelegramNotificationsStatus(
            Configured: true,
            Enabled: config.Enabled,
            ChatId: config.ChatId,
            ServerName: config.ServerName,
            DefaultServerName: MachineName,
            Kinds: config.Kinds,
            SendResolved: config.SendResolved,
            SentCount: delivery.SentCount,
            LastSentAtUnixMs: delivery.LastSentAt,
            LastFailedAtUnixMs: delivery.LastFailedAt,
            LastError: delivery.LastError,
            ChangedAtUnixMs: config.ChangedAt,
            ChangedBy: config.ChangedBy);
    }

    private sealed record Delivery(long SentCount, long? LastSentAt, long? LastFailedAt, string? LastError)
    {
        public static Delivery None { get; } = new(0, null, null, null);
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "A Telegram notification was not delivered: {Reason}")]
    private static partial void LogNotDelivered(ILogger logger, string reason);

    [LoggerMessage(Level = LogLevel.Warning, Message = "The Telegram settings could not be read, so notifications are off until they are set up again.")]
    private static partial void LogLoadFailed(ILogger logger, Exception exception);

    [LoggerMessage(Level = LogLevel.Information, Message = "Telegram notifications were removed by {User}.")]
    private static partial void LogRemoved(ILogger logger, string user);
}
