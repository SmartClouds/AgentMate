using System.Threading.Channels;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Platform;

namespace Runova.ServerCore.Metrics;

/// <summary>Samples for one live stream. Disposing it unsubscribes.</summary>
internal sealed class MetricsSubscription(ChannelReader<MetricsSample> reader, Action unsubscribe) : IDisposable
{
    public ChannelReader<MetricsSample> Reader { get; } = reader;

    public void Dispose() => unsubscribe();
}

/// <summary>
/// Reads the server every few seconds and turns each reading into a sample. The last 15 minutes
/// stay in memory for live charts; every finished minute is stored as its average, and every
/// finished quarter hour as the average of its minutes. The server is read every five seconds,
/// or as often as the fastest live subscriber asks (down to once a second).
/// </summary>
internal sealed partial class MetricsSampler(
    ISystemProbe probe,
    MetricsStore store,
    TimeProvider time,
    ILogger<MetricsSampler> logger) : BackgroundService
{
    /// <summary>Samples a subscriber may fall behind by; older ones are dropped, the newest kept.</summary>
    public const int SubscriberBuffer = 16;

    public const int MaxHistoryPoints = 3000;

    public static readonly TimeSpan IdlePeriod = TimeSpan.FromSeconds(5);

    public static readonly TimeSpan MinInterval = TimeSpan.FromSeconds(1);

    public static readonly TimeSpan MaxInterval = TimeSpan.FromSeconds(60);

    public static readonly TimeSpan LiveWindow = TimeSpan.FromMinutes(15);

    /// <summary>
    /// A reading this soon after the last one is skipped: its rates would be noise. It also keeps a
    /// timer tick and a direct call at the same moment from making two samples.
    /// </summary>
    public static readonly TimeSpan MinimumGap = TimeSpan.FromMilliseconds(250);

    private const long MinuteMs = 60_000;
    private const long QuarterMs = 900_000;

    private static readonly TimeSpan _diskEvery = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan _pruneEvery = TimeSpan.FromHours(1);

    private readonly SemaphoreSlim _sampling = new(1, 1);
    private readonly Lock _gate = new();
    private readonly Queue<MetricsSample> _live = new();
    private readonly List<MetricsSample> _minute = [];
    private readonly List<Subscriber> _subscribers = [];
    private (SystemCounters Counters, long Timestamp)? _previous;
    private (long Total, long Used) _rootDisk;
    private long? _diskReadAt;
    private long? _prunedAt;
    private long _minuteStart = -1;
    private long _quarterStart = -1;
    private PeriodicTimer? _timer;

    /// <summary>How often the server is read now.</summary>
    public TimeSpan Period
    {
        get
        {
            lock (_gate)
            {
                return CurrentPeriod();
            }
        }
    }

    /// <summary>A stream's interval: five seconds unless asked otherwise, never under one or over sixty.</summary>
    public static TimeSpan ClampInterval(int? intervalMs) => TimeSpan.FromMilliseconds(Math.Clamp(
        intervalMs ?? (int)IdlePeriod.TotalMilliseconds,
        (int)MinInterval.TotalMilliseconds,
        (int)MaxInterval.TotalMilliseconds));

    /// <summary>
    /// Reads the server once. Null for the first reading, which only sets the baseline, and for one
    /// that comes too soon after the last.
    /// </summary>
    public async Task<MetricsSample?> SampleOnceAsync(CancellationToken cancellationToken)
    {
        await _sampling.WaitAsync(cancellationToken);
        try
        {
            var counters = probe.ReadCounters();
            var timestamp = time.GetTimestamp();
            var now = time.GetUtcNow().ToUnixTimeMilliseconds();
            if (_previous is { } last && time.GetElapsedTime(last.Timestamp, timestamp) < MinimumGap)
            {
                return null;
            }

            RefreshRootDisk(now);
            var previous = _previous;
            _previous = (counters, timestamp);
            if (previous is not { } before)
            {
                return null;
            }

            var elapsed = time.GetElapsedTime(before.Timestamp, timestamp).TotalSeconds;
            var sample = MetricsMath.Sample(before.Counters, counters, elapsed, now, _rootDisk);
            var (finishedMinute, finishedQuarter) = Record(sample);
            Publish(sample);
            await StoreAsync(finishedMinute, finishedQuarter, now, cancellationToken);
            return sample;
        }
        finally
        {
            _sampling.Release();
        }
    }

    /// <summary>Buffered samples taken after the given time, oldest first.</summary>
    public IReadOnlyList<MetricsSample> LiveSince(long sinceUnixMs)
    {
        lock (_gate)
        {
            return [.. _live.Where(sample => sample.AtUnixMs > sinceUnixMs)];
        }
    }

    public async Task<MetricsHistory> HistoryAsync(MetricsHistoryRequest request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        var now = time.GetUtcNow().ToUnixTimeMilliseconds();
        var to = request.ToUnixMs ?? now + 1;
        switch (request.Resolution)
        {
            case MetricsResolution.Live:
                var from = request.FromUnixMs ?? now - (long)LiveWindow.TotalMilliseconds;
                return new MetricsHistory(
                    MetricsResolution.Live,
                    (int)Period.TotalSeconds,
                    [.. LiveSince(from - 1).Where(sample => sample.AtUnixMs < to).TakeLast(MaxHistoryPoints)]);
            case MetricsResolution.Minute:
                return new MetricsHistory(
                    MetricsResolution.Minute,
                    MetricsStore.Minute,
                    [.. await store.ReadAsync(
                        MetricsStore.Minute,
                        request.FromUnixMs ?? now - (long)MetricsStore.KeepMinutes.TotalMilliseconds,
                        to,
                        MaxHistoryPoints,
                        cancellationToken)]);
            case MetricsResolution.QuarterHour:
                return new MetricsHistory(
                    MetricsResolution.QuarterHour,
                    MetricsStore.QuarterHour,
                    [.. await store.ReadAsync(
                        MetricsStore.QuarterHour,
                        request.FromUnixMs ?? now - (long)MetricsStore.KeepQuarterHours.TotalMilliseconds,
                        to,
                        MaxHistoryPoints,
                        cancellationToken)]);
            default:
                throw new ArgumentOutOfRangeException(nameof(request), "There is no such resolution.");
        }
    }

    public Task<int> PruneAsync(CancellationToken cancellationToken) => store.PruneAsync(time.GetUtcNow(), cancellationToken);

    /// <summary>
    /// Samples from now on, at least <paramref name="interval"/> apart (clamped to 1 to 60 seconds).
    /// The server is read as often as the fastest subscriber needs.
    /// </summary>
    public MetricsSubscription Subscribe(TimeSpan interval)
    {
        var subscriber = new Subscriber(TimeSpan.FromTicks(Math.Clamp(interval.Ticks, MinInterval.Ticks, MaxInterval.Ticks)));
        lock (_gate)
        {
            _subscribers.Add(subscriber);
            UpdateTimer();
        }

        return new MetricsSubscription(subscriber.Channel.Reader, () =>
        {
            lock (_gate)
            {
                _subscribers.Remove(subscriber);
                UpdateTimer();
            }

            subscriber.Channel.Writer.TryComplete();
        });
    }

    public override void Dispose()
    {
        base.Dispose();
        _sampling.Dispose();
    }

    /// <remarks>
    /// The pace is real time even when the core runs on a test clock: every reading still takes
    /// its time from the injected clock, but a test that moves that clock by months must not make
    /// the timer replay millions of ticks.
    /// </remarks>
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(Period, TimeProvider.System);
        lock (_gate)
        {
            _timer = timer;
        }

        try
        {
            do
            {
                try
                {
                    await SampleOnceAsync(stoppingToken);
                }
                catch (Exception error) when (error is not OperationCanceledException)
                {
                    LogSampleFailed(logger, error);
                }
            }
            while (await timer.WaitForNextTickAsync(stoppingToken));
        }
        finally
        {
            lock (_gate)
            {
                _timer = null;
            }
        }
    }

    /// <summary>
    /// Adds the sample to the live buffer and to its minute. The first sample of a new minute (or
    /// quarter hour) closes the one before it, which is returned for storing.
    /// </summary>
    private (MetricsSample? Minute, long? Quarter) Record(MetricsSample sample)
    {
        lock (_gate)
        {
            _live.Enqueue(sample);
            var oldest = sample.AtUnixMs - (long)LiveWindow.TotalMilliseconds;
            while (_live.Count > 0 && _live.Peek().AtUnixMs < oldest)
            {
                _live.Dequeue();
            }

            MetricsSample? finishedMinute = null;
            long? finishedQuarter = null;
            var minute = sample.AtUnixMs - (sample.AtUnixMs % MinuteMs);
            if (minute != _minuteStart)
            {
                if (_minuteStart >= 0 && _minute.Count > 0)
                {
                    finishedMinute = MetricsMath.Average(_minute, _minuteStart);
                }

                var quarter = minute - (minute % QuarterMs);
                if (_quarterStart >= 0 && quarter != _quarterStart)
                {
                    finishedQuarter = _quarterStart;
                }

                _minute.Clear();
                _minuteStart = minute;
                _quarterStart = quarter;
            }

            _minute.Add(sample);
            return (finishedMinute, finishedQuarter);
        }
    }

    private async Task StoreAsync(MetricsSample? minute, long? quarter, long now, CancellationToken cancellationToken)
    {
        try
        {
            if (minute is not null)
            {
                await store.SaveAsync(MetricsStore.Minute, minute, cancellationToken);
            }

            if (quarter is long start)
            {
                var minutes = await store.ReadAsync(MetricsStore.Minute, start, start + QuarterMs, 15, cancellationToken);
                if (minutes.Count > 0)
                {
                    await store.SaveAsync(MetricsStore.QuarterHour, MetricsMath.Average(minutes, start), cancellationToken);
                }
            }

            if (_prunedAt is null || now - _prunedAt >= (long)_pruneEvery.TotalMilliseconds)
            {
                _prunedAt = now;
                await store.PruneAsync(time.GetUtcNow(), cancellationToken);
            }
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            // History has a gap; the live samples carry on.
            LogStoreFailed(logger, error);
        }
    }

    private void Publish(MetricsSample sample)
    {
        lock (_gate)
        {
            var tolerance = CurrentPeriod().TotalMilliseconds / 2;
            foreach (var subscriber in _subscribers)
            {
                if (subscriber.LastAt is long last && sample.AtUnixMs - last < subscriber.Interval.TotalMilliseconds - tolerance)
                {
                    continue;
                }

                subscriber.LastAt = sample.AtUnixMs;
                subscriber.Channel.Writer.TryWrite(sample);
            }
        }
    }

    /// <summary>The root filesystem's size, refreshed every half minute: it changes slowly.</summary>
    private void RefreshRootDisk(long now)
    {
        if (_diskReadAt is long read && now - read < (long)_diskEvery.TotalMilliseconds)
        {
            return;
        }

        _diskReadAt = now;
        try
        {
            var filesystems = probe.ReadFilesystems();
            var root = filesystems.FirstOrDefault(disk => disk.MountPoint == "/") ?? (filesystems.Count > 0 ? filesystems[0] : null);
            _rootDisk = root is null ? (0, 0) : (root.TotalBytes, root.UsedBytes);
        }
        catch (Exception error) when (error is IOException or InvalidOperationException or UnauthorizedAccessException)
        {
            LogDiskFailed(logger, error);
        }
    }

    private TimeSpan CurrentPeriod() =>
        _subscribers.Count == 0 ? IdlePeriod : TimeSpan.FromTicks(Math.Min(IdlePeriod.Ticks, _subscribers.Min(s => s.Interval.Ticks)));

    private void UpdateTimer()
    {
        var period = CurrentPeriod();
        if (_timer is { } timer && timer.Period != period)
        {
            timer.Period = period;
        }
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "Reading the server's metrics failed; trying again at the next tick.")]
    private static partial void LogSampleFailed(ILogger logger, Exception error);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Storing the metrics history failed; the history has a gap.")]
    private static partial void LogStoreFailed(ILogger logger, Exception error);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Reading the filesystem sizes failed.")]
    private static partial void LogDiskFailed(ILogger logger, Exception error);

    private sealed class Subscriber(TimeSpan interval)
    {
        public TimeSpan Interval { get; } = interval;

        public Channel<MetricsSample> Channel { get; } = System.Threading.Channels.Channel.CreateBounded<MetricsSample>(
            new BoundedChannelOptions(SubscriberBuffer) { SingleReader = true, FullMode = BoundedChannelFullMode.DropOldest });

        public long? LastAt { get; set; }
    }
}
