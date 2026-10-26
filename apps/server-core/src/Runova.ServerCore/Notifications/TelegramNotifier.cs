using Runova.ServerCore.Alerts;
using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.Notifications;

/// <summary>
/// Tells the Telegram chat about alerts as they change (E30): when one opens, gets worse or clears,
/// following the settings as they are at that moment. It runs whether or not anyone has the app open.
/// It starts from the alerts as they are when the core starts, so a restart sends nothing that was
/// already open, and when it falls behind the alert center it picks up from the last change it handled.
/// </summary>
internal sealed partial class TelegramNotifier(AlertCenter alerts, TelegramManager manager, ILogger<TelegramNotifier> logger) : BackgroundService
{
    private readonly TaskCompletionSource _listening = new(TaskCreationOptions.RunContinuationsAsynchronously);

    /// <summary>The highest severity a message went out for, per open alert.</summary>
    private readonly Dictionary<long, AlertSeverity> _announced = [];

    private long _lastRevision;

    /// <summary>Done once the notifier hears every change from now on.</summary>
    public Task Listening => _listening.Task;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var first = true;
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                using var subscription = alerts.Subscribe();
                if (first)
                {
                    await StartFromNowAsync(stoppingToken);
                    first = false;
                    _listening.TrySetResult();
                }
                else
                {
                    foreach (var missed in await alerts.ChangesAfterAsync(_lastRevision, AlertCenter.MaxListed, stoppingToken))
                    {
                        await HandleAsync(missed, stoppingToken);
                    }
                }

                await foreach (var change in subscription.Reader.ReadAllAsync(stoppingToken))
                {
                    await HandleAsync(change, stoppingToken);
                }

                // The alert center let this subscriber go for falling behind: subscribe again and catch up.
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
#pragma warning disable CA1031 // A broken notification must never take the core down; try again shortly.
            catch (Exception problem)
#pragma warning restore CA1031
            {
                LogFailed(logger, problem);
                await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken).ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
            }
        }
    }

    /// <summary>
    /// Alerts open now count as told about when the settings in use would have sent them: so they are
    /// not sent again on every restart, but their clearing still is.
    /// </summary>
    private async Task StartFromNowAsync(CancellationToken cancellationToken)
    {
        _lastRevision = await alerts.LatestRevisionAsync(cancellationToken);
        var config = manager.Current;
        foreach (var open in await alerts.ListAsync(new AlertQuery(IncludeResolved: false, Limit: AlertCenter.MaxListed), cancellationToken))
        {
            _lastRevision = Math.Max(_lastRevision, open.Revision);
            if (TelegramPolicy.Decide(open, announced: null, config) is TelegramChange.Opened)
            {
                _announced[open.Id] = open.Severity;
            }
        }
    }

    private async Task HandleAsync(AlertInfo change, CancellationToken cancellationToken)
    {
        if (change.Revision <= _lastRevision)
        {
            return;
        }

        _lastRevision = change.Revision;
        AlertSeverity? announced = _announced.TryGetValue(change.Id, out var told) ? told : null;
        var decision = TelegramPolicy.Decide(change, announced, manager.Current);
        if (change.ResolvedAtUnixMs is not null)
        {
            _announced.Remove(change.Id);
        }

        if (decision is not TelegramChange what || manager.Current is not { } config)
        {
            return;
        }

        var result = await manager.DeliverAsync(TelegramMessages.Compose(change, config.ServerName, what), cancellationToken);
        if (result.Delivered && what is not TelegramChange.Resolved)
        {
            _announced[change.Id] = change.Severity;
        }
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "The Telegram notifier stopped listening to alerts and starts again shortly.")]
    private static partial void LogFailed(ILogger logger, Exception exception);
}
