using AgentMate.ServerCore.Contracts;
using AgentMate.ServerCore.Docker;

namespace AgentMate.ServerCore.Alerts;

/// <summary>Whether the container watcher runs. The test core turns it off, so stopping containers in a test raises nothing.</summary>
internal sealed record ContainerWatchOptions(bool RunInBackground = true)
{
    public static ContainerWatchOptions Default { get; } = new();
}

/// <summary>
/// Follows Docker's events in the background and raises an alert for a container in a crash loop
/// (E30), so it is noticed while nobody has the app open. Without Docker it waits and tries again,
/// longer each time up to a minute. Loops still open from before a restart clear like any other
/// once their container has been quiet.
/// </summary>
internal sealed partial class ContainerWatcher(
    IDockerEngine engine,
    AlertCenter alerts,
    TimeProvider time,
    ContainerWatchOptions options,
    ILogger<ContainerWatcher> logger) : BackgroundService
{
    public static readonly TimeSpan SweepEvery = TimeSpan.FromMinutes(1);

    private static readonly TimeSpan _firstRetry = TimeSpan.FromSeconds(5);

    private static readonly TimeSpan _longestRetry = TimeSpan.FromMinutes(1);

    private readonly CrashLoopDetector _detector = new(time);

    private readonly Lock _gate = new();

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.RunInBackground)
        {
            return;
        }

        // From the moment the core starts: crashes from before it are not counted again. Taken before
        // the first await, so nothing that happens while the open alerts are read is missed.
        var since = new EventCursor(time.GetUtcNow().ToUnixTimeMilliseconds() * 1_000_000);
        try
        {
            foreach (var open in await alerts.OpenAsync(AlertKind.ContainerCrashLoop, stoppingToken))
            {
                lock (_gate)
                {
                    _detector.Assume(open.Resource);
                }
            }
        }
        catch (Exception problem) when (problem is not OperationCanceledException)
        {
            LogFailed(logger, problem);
        }

        await Task.WhenAll(WatchAsync(since, stoppingToken), SweepAsync(stoppingToken));
    }

    private async Task WatchAsync(EventCursor since, CancellationToken stoppingToken)
    {
        var retry = _firstRetry;
        var toldUnavailable = false;
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await foreach (var engineEvent in engine.StreamEventsAsync(since, stoppingToken))
                {
                    since = new EventCursor(engineEvent.TimeNano + 1);
                    retry = _firstRetry;
                    toldUnavailable = false;
                    CrashLoopChange? change;
                    lock (_gate)
                    {
                        change = _detector.Observe(engineEvent);
                    }

                    await ApplyAsync(change, stoppingToken);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
#pragma warning disable CA1031 // Docker missing, stopped or restarting: wait and follow it again.
            catch (Exception problem)
#pragma warning restore CA1031
            {
                if (!toldUnavailable)
                {
                    LogUnavailable(logger, problem.Message);
                    toldUnavailable = true;
                }
            }

            await Task.Delay(retry, time, stoppingToken).ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
            retry = retry * 2 > _longestRetry ? _longestRetry : retry * 2;
        }
    }

    private async Task SweepAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(SweepEvery, time);
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                IReadOnlyList<CrashLoopCleared> cleared;
                lock (_gate)
                {
                    cleared = _detector.Sweep();
                }

                foreach (var change in cleared)
                {
                    await ApplyAsync(change, stoppingToken);
                }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
    }

    private async Task ApplyAsync(CrashLoopChange? change, CancellationToken cancellationToken)
    {
        try
        {
            switch (change)
            {
                case CrashLoopRaised raised:
                    await alerts.RaiseAsync(AlertKind.ContainerCrashLoop, raised.Container, AlertSeverity.Critical, raised.Message, cancellationToken);
                    break;
                case CrashLoopCleared cleared:
                    await alerts.ResolveAsync(AlertKind.ContainerCrashLoop, cleared.Container, cancellationToken);
                    break;
            }
        }
        catch (Exception problem) when (problem is not OperationCanceledException)
        {
            LogFailed(logger, problem);
        }
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Docker's events cannot be followed right now ({Reason}); crash loops are watched again once it answers.")]
    private static partial void LogUnavailable(ILogger logger, string reason);

    [LoggerMessage(Level = LogLevel.Warning, Message = "A crash loop alert could not be recorded.")]
    private static partial void LogFailed(ILogger logger, Exception exception);
}
