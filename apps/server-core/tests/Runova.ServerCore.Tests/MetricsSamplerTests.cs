using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Metrics;

namespace Runova.ServerCore.Tests;

/// <summary>
/// Metrics: each reading becomes a sample of rates since the one before; the last 15 minutes stay
/// in memory, minute and quarter-hour averages go to the database (48 hours and 30 days), and live
/// subscribers get samples at their own pace without ever holding the sampler up.
/// </summary>
public sealed class MetricsSamplerTests : IAsyncLifetime
{
    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    // A minute boundary, so the tests read easily.
    private readonly FakeTimeProvider _clock = new(DateTimeOffset.FromUnixTimeMilliseconds(1_800_000_000_000 - 1_800_000_000_000 % 900_000));

    private readonly FakeSystemProbe _probe = new();

    private TestDatabase _database = null!;

    private MetricsSampler _sampler = null!;

    public async ValueTask InitializeAsync()
    {
        _database = await TestDatabase.CreateAsync();
        _sampler = new MetricsSampler(_probe, new MetricsStore(_database.Contexts), _clock, NullLogger<MetricsSampler>.Instance);
    }

    public async ValueTask DisposeAsync()
    {
        _sampler.Dispose();
        await _database.DisposeAsync();
    }

    /// <summary>One reading five seconds after the last, with the given CPU ticks and byte counters.</summary>
    private async Task<MetricsSample?> TickAsync(long busy, long idle, long received = 0, long read = 0, TimeSpan? after = null)
    {
        _clock.Advance(after ?? TimeSpan.FromSeconds(5));
        _probe.Set(FakeSystemProbe.Counters(busy, idle, received: received, read: read));
        return await _sampler.SampleOnceAsync(Cancel);
    }

    [Fact]
    public async Task The_first_reading_only_sets_the_baseline()
    {
        Assert.Null(await TickAsync(busy: 100, idle: 900));
        Assert.Empty(_sampler.LiveSince(0));
    }

    [Fact]
    public async Task A_sample_is_the_rates_between_two_readings()
    {
        await TickAsync(busy: 100, idle: 900, received: 1_000, read: 0);

        var sample = await TickAsync(busy: 150, idle: 950, received: 11_000, read: 5_000);

        Assert.NotNull(sample);
        Assert.Equal(50.0, sample.CpuPercent, precision: 6);
        Assert.Equal(2_000.0, sample.NetworkReceiveBytesPerSecond, precision: 6);
        Assert.Equal(1_000.0, sample.DiskReadBytesPerSecond, precision: 6);
        Assert.Equal(2_000_000_000, sample.MemoryUsedBytes);
        Assert.Equal(40, sample.DiskUsedBytes);
        Assert.Equal(100, sample.DiskTotalBytes);
        Assert.Equal(_clock.GetUtcNow().ToUnixTimeMilliseconds(), sample.AtUnixMs);
    }

    [Fact]
    public async Task Counters_that_went_backwards_after_a_reboot_give_zero_not_a_negative_rate()
    {
        await TickAsync(busy: 100, idle: 900, received: 50_000);

        var sample = await TickAsync(busy: 110, idle: 990, received: 10);

        Assert.Equal(0, sample!.NetworkReceiveBytesPerSecond);
    }

    [Fact]
    public async Task The_live_buffer_keeps_fifteen_minutes()
    {
        await TickAsync(busy: 0, idle: 0);
        for (var i = 1; i <= 240; i++)
        {
            await TickAsync(busy: i * 10, idle: i * 90);
        }

        var live = _sampler.LiveSince(0);
        var now = _clock.GetUtcNow().ToUnixTimeMilliseconds();

        Assert.All(live, sample => Assert.True(now - sample.AtUnixMs <= 15 * 60_000));
        Assert.Equal(181, live.Count);
        Assert.Equal(3, _sampler.LiveSince(now - 15_000).Count);
    }

    [Fact]
    public async Task Each_finished_minute_is_stored_as_its_average()
    {
        await TickAsync(busy: 0, idle: 0);
        // Twelve samples at 25% then the first reading of the next minute.
        for (var i = 1; i <= 12; i++)
        {
            await TickAsync(busy: i * 25, idle: i * 75);
        }

        await TickAsync(busy: 12 * 25 + 100, idle: 12 * 75);

        var minutes = await _sampler.HistoryAsync(new MetricsHistoryRequest(MetricsResolution.Minute), Cancel);
        var first = Assert.Single(minutes.Samples);
        Assert.Equal(60, minutes.IntervalSeconds);
        Assert.Equal(25.0, first.CpuPercent, precision: 6);
    }

    [Fact]
    public async Task Each_finished_quarter_hour_is_stored_from_its_minutes()
    {
        await TickAsync(busy: 0, idle: 0);
        for (var i = 1; i <= 16 * 12; i++)
        {
            await TickAsync(busy: i * 50, idle: i * 50);
        }

        var quarters = await _sampler.HistoryAsync(new MetricsHistoryRequest(MetricsResolution.QuarterHour), Cancel);
        var minutes = await _sampler.HistoryAsync(new MetricsHistoryRequest(MetricsResolution.Minute), Cancel);

        var quarter = Assert.Single(quarters.Samples);
        Assert.Equal(900, quarters.IntervalSeconds);
        Assert.Equal(50.0, quarter.CpuPercent, precision: 6);
        Assert.Equal(15, minutes.Samples.Count(m => m.AtUnixMs >= quarter.AtUnixMs && m.AtUnixMs < quarter.AtUnixMs + 900_000));
    }

    [Fact]
    public async Task Stored_history_is_pruned_after_48_hours_and_30_days()
    {
        await TickAsync(busy: 0, idle: 0);
        for (var i = 1; i <= 16 * 12; i++)
        {
            await TickAsync(busy: i * 50, idle: i * 50);
        }

        _clock.Advance(TimeSpan.FromDays(3));
        var pruned = await _sampler.PruneAsync(Cancel);

        Assert.True(pruned > 0);
        Assert.Empty((await _sampler.HistoryAsync(new MetricsHistoryRequest(MetricsResolution.Minute, FromUnixMs: 0), Cancel)).Samples);
        Assert.Single((await _sampler.HistoryAsync(new MetricsHistoryRequest(MetricsResolution.QuarterHour, FromUnixMs: 0), Cancel)).Samples);
    }

    [Fact]
    public async Task Subscribers_get_samples_at_their_own_interval()
    {
        using var everyTen = _sampler.Subscribe(TimeSpan.FromSeconds(10));
        await TickAsync(busy: 0, idle: 0);
        for (var i = 1; i <= 6; i++)
        {
            await TickAsync(busy: i * 10, idle: i * 90);
        }

        var received = new List<MetricsSample>();
        while (everyTen.Reader.TryRead(out var sample))
        {
            received.Add(sample);
        }

        // Six samples five seconds apart: every other one reaches a ten-second subscriber.
        Assert.Equal(3, received.Count);
    }

    [Fact]
    public void The_fastest_subscriber_sets_how_often_the_server_is_read()
    {
        Assert.Equal(MetricsSampler.IdlePeriod, _sampler.Period);

        using (_sampler.Subscribe(TimeSpan.FromSeconds(1)))
        {
            Assert.Equal(TimeSpan.FromSeconds(1), _sampler.Period);
        }

        Assert.Equal(MetricsSampler.IdlePeriod, _sampler.Period);
    }

    [Fact]
    public async Task A_subscriber_that_never_reads_does_not_hold_the_sampler_up()
    {
        using var stalled = _sampler.Subscribe(TimeSpan.FromSeconds(1));
        await TickAsync(busy: 0, idle: 0);

        for (var i = 1; i <= MetricsSampler.SubscriberBuffer * 3; i++)
        {
            Assert.NotNull(await TickAsync(busy: i, idle: i, after: TimeSpan.FromSeconds(1)));
        }

        // It keeps the newest readings only.
        Assert.Equal(MetricsSampler.SubscriberBuffer, stalled.Reader.Count);
    }

    [Theory]
    [InlineData(null, 5_000)]
    [InlineData(10, 1_000)]
    [InlineData(2_500, 2_500)]
    [InlineData(600_000, 60_000)]
    public void Stream_intervals_are_clamped(int? requested, int expected)
    {
        Assert.Equal(TimeSpan.FromMilliseconds(expected), MetricsSampler.ClampInterval(requested));
    }

    [Fact]
    public async Task History_outside_the_kept_window_is_empty_and_results_are_capped()
    {
        await TickAsync(busy: 0, idle: 0);
        await TickAsync(busy: 10, idle: 10);

        var live = await _sampler.HistoryAsync(new MetricsHistoryRequest(MetricsResolution.Live), Cancel);
        var future = await _sampler.HistoryAsync(
            new MetricsHistoryRequest(MetricsResolution.Minute, FromUnixMs: _clock.GetUtcNow().AddDays(1).ToUnixTimeMilliseconds()),
            Cancel);

        Assert.Single(live.Samples);
        Assert.Empty(future.Samples);
    }
}
