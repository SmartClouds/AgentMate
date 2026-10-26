using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.DependencyInjection;
using Runova.ServerCore.Alerts;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Hubs;
using Runova.ServerCore.Metrics;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Tests;

/// <summary>
/// The hub's streams through a real connection: metrics, a job's log and alerts, each resumable
/// after a reconnect without gaps or repeats, and each counted against the connection's limits.
/// </summary>
public sealed class HubStreamTests
{
    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private static async Task<HubConnection> ConnectAsync(AuthHarness harness)
    {
        var signedIn = await harness.SignInAsync();
        var hub = harness.Hub(signedIn.AccessToken);
        await hub.StartAsync(Cancel);
        return hub;
    }

    /// <summary>Reads from a stream until the condition holds, with a time limit.</summary>
    private static async Task<List<T>> ReadUntilAsync<T>(IAsyncEnumerator<T> stream, Func<List<T>, bool> done)
    {
        var items = new List<T>();
        while (!done(items))
        {
            Assert.True(await stream.MoveNextAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(10), Cancel), "The stream ended early.");
            items.Add(stream.Current);
        }

        return items;
    }

    /// <summary>
    /// Readings five seconds apart, a quarter of each busy. The sampler's own timer runs on the same
    /// fake clock, so it may take a reading first; either way there is one sample per step.
    /// </summary>
    private static async Task<List<MetricsSample>> SampleAsync(AuthHarness harness, int times)
    {
        var sampler = harness.Services.GetRequiredService<MetricsSampler>();
        var probe = harness.Services.GetRequiredService<FakeSystemProbe>();
        var taken = new List<MetricsSample>();
        for (var i = 1; i <= times; i++)
        {
            var cpu = probe.ReadCounters().Cpu;
            probe.Set(FakeSystemProbe.Counters(cpuBusy: cpu.User + 10, cpuIdle: cpu.Idle + 30));
            harness.Clock!.Advance(TimeSpan.FromSeconds(5));
            await sampler.SampleOnceAsync(Cancel);
            var now = harness.Clock.GetUtcNow().ToUnixTimeMilliseconds();
            taken.Add(Assert.Single(sampler.LiveSince(now - 1)));
        }

        return taken;
    }

    [Fact]
    public async Task Live_metrics_reach_a_viewer_and_resume_after_a_reconnect()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Viewer);
        var before = await SampleAsync(harness, 3);
        long lastSeen;
        await using (var hub = await ConnectAsync(harness))
        {
            await using var stream = hub.StreamAsync<MetricsSample>(
                nameof(ICoreHub.StreamMetrics),
                new MetricsStreamRequest(IntervalMs: 5_000, SinceUnixMs: 0),
                Cancel).GetAsyncEnumerator(Cancel);
            var replayed = await ReadUntilAsync(stream, items => items.Count > 0 && items[^1].AtUnixMs == before[^1].AtUnixMs);
            var next = (await SampleAsync(harness, 1))[0];
            var live = await ReadUntilAsync(stream, items => items.Count > 0 && items[^1].AtUnixMs == next.AtUnixMs);
            lastSeen = next.AtUnixMs;

            Assert.Equal(25.0, live[^1].CpuPercent, precision: 6);
            var times = replayed.Concat(live).Select(sample => sample.AtUnixMs).ToList();
            Assert.Equal(times.Order(), times);
            Assert.Equal(times.Count, times.Distinct().Count());
        }

        // Samples taken while the app was away come first on the next connection, and only those.
        var whileAway = await SampleAsync(harness, 2);
        await using var again = await ConnectAsync(harness);
        await using var resumed = again.StreamAsync<MetricsSample>(
            nameof(ICoreHub.StreamMetrics),
            new MetricsStreamRequest(IntervalMs: 5_000, SinceUnixMs: lastSeen),
            Cancel).GetAsyncEnumerator(Cancel);
        var missed = await ReadUntilAsync(resumed, items => items.Count == 2);

        Assert.Equal(whileAway.Select(sample => sample.AtUnixMs), missed.Select(sample => sample.AtUnixMs));
    }

    [Fact]
    public async Task A_job_log_streams_to_its_end_and_resumes_after_the_last_line_seen()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Operator);
        await using var hub = await ConnectAsync(harness);
        var job = await hub.InvokeAsync<JobInfo>(nameof(ICoreHub.UpgradeSecurityPackages), Cancel);

        var all = new List<JobStreamItem>();
        await foreach (var item in hub.StreamAsync<JobStreamItem>(nameof(ICoreHub.StreamJob), job.Id, 0L, Cancel))
        {
            all.Add(item);
        }

        var lines = all.SelectMany(item => item.Lines).ToList();
        var afterSecond = new List<JobLogLine>();
        await foreach (var item in hub.StreamAsync<JobStreamItem>(nameof(ICoreHub.StreamJob), job.Id, 2L, Cancel))
        {
            afterSecond.AddRange(item.Lines);
        }

        Assert.Equal(JobState.Succeeded, all[^1].Job!.State);
        Assert.Contains(lines, line => line.Text == "Reading package lists...");
        Assert.Equal(lines.Skip(2).Select(line => line.Seq), afterSecond.Select(line => line.Seq));
    }

    [Fact]
    public async Task Streaming_a_job_that_does_not_exist_is_refused()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Viewer);
        await using var hub = await ConnectAsync(harness);

        var refusal = await Assert.ThrowsAsync<HubException>(async () =>
        {
            await foreach (var _ in hub.StreamAsync<JobStreamItem>(nameof(ICoreHub.StreamJob), Guid.NewGuid(), 0L, Cancel))
            {
            }
        });

        Assert.Contains("no such job", refusal.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Alerts_stream_as_they_change_and_resume_from_a_revision()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Viewer);
        var alerts = harness.Services.GetRequiredService<AlertCenter>();
        var disk = await alerts.RaiseAsync(AlertKind.DiskPressure, "/", AlertSeverity.Warning, "/ is 91% full", Cancel);
        await using var hub = await ConnectAsync(harness);

        await using (var stream = hub.StreamAsync<AlertInfo>(
            nameof(ICoreHub.StreamAlerts),
            new AlertStreamRequest(),
            Cancel).GetAsyncEnumerator(Cancel))
        {
            var open = await ReadUntilAsync(stream, items => items.Count == 1);
            await alerts.RaiseAsync(AlertKind.RebootRequired, "system", AlertSeverity.Warning, "A reboot is needed.", Cancel);
            var live = await ReadUntilAsync(stream, items => items.Count == 1);

            Assert.Equal(disk.Id, open[0].Id);
            Assert.Equal(AlertKind.RebootRequired, live[0].Kind);
        }

        await alerts.ResolveAsync(AlertKind.DiskPressure, "/", Cancel);
        await using var resumed = hub.StreamAsync<AlertInfo>(
            nameof(ICoreHub.StreamAlerts),
            new AlertStreamRequest(AfterRevision: disk.Revision + 1),
            Cancel).GetAsyncEnumerator(Cancel);
        var missed = await ReadUntilAsync(resumed, items => items.Count == 1);

        Assert.Equal(disk.Id, missed[0].Id);
        Assert.NotNull(missed[0].ResolvedAtUnixMs);
    }

    [Fact]
    public async Task A_connection_cannot_open_more_streams_than_its_limit_but_still_makes_calls()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Viewer);
        await using var hub = await ConnectAsync(harness);
        var open = new List<IAsyncEnumerator<AlertInfo>>();
        for (var i = 0; i < StreamLimits.PerKind[StreamLimits.Alerts]; i++)
        {
            var stream = hub.StreamAsync<AlertInfo>(nameof(ICoreHub.StreamAlerts), new AlertStreamRequest(), Cancel).GetAsyncEnumerator(Cancel);
            open.Add(stream);
        }

        // Nothing to replay, so each stream is merely open; the next one is one too many.
        await harness.Services.GetRequiredService<AlertCenter>().RaiseAsync(AlertKind.DiskPressure, "/", AlertSeverity.Warning, "full", Cancel);
        foreach (var stream in open)
        {
            await ReadUntilAsync(stream, items => items.Count == 1);
        }

        var refusal = await Assert.ThrowsAsync<HubException>(async () =>
        {
            await foreach (var _ in hub.StreamAsync<AlertInfo>(nameof(ICoreHub.StreamAlerts), new AlertStreamRequest(), Cancel))
            {
            }
        });
        var ping = await hub.InvokeAsync<PingResponse>(nameof(ICoreHub.Ping), Cancel);

        Assert.Contains("streams open", refusal.Message, StringComparison.Ordinal);
        Assert.True(ping.ServerTimeUnixMs > 0);
        foreach (var stream in open)
        {
            await stream.DisposeAsync();
        }
    }

    [Fact]
    public async Task A_message_bigger_than_the_limit_is_refused()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Viewer);
        await using var hub = await ConnectAsync(harness);
        var closed = new TaskCompletionSource<Exception?>();
        hub.Closed += error =>
        {
            closed.TrySetResult(error);
            return Task.CompletedTask;
        };

        var tooBig = hub.InvokeAsync<AlertInfo[]>(nameof(ICoreHub.ListAlerts), new string('x', 128 * 1024), Cancel);

        // The core closes a connection that sends more than 64 KB in one message.
        await closed.Task.WaitAsync(TimeSpan.FromSeconds(10), Cancel);

        // The call itself fails with the connection. Observed here, so it is not left for the finalizer
        // to throw into whichever test host is running by then.
        await Assert.ThrowsAnyAsync<Exception>(() => tooBig);
    }
}
