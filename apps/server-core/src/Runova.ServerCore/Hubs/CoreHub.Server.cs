using System.Runtime.CompilerServices;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Runova.ServerCore.Alerts;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Metrics;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Hubs;

/// <summary>
/// Reading the server: facts, services, metrics, updates, jobs and alerts. Open to every role; none
/// of it changes anything. Each stream counts against the connection's limits while it is open.
/// </summary>
internal sealed partial class CoreHub
{
    [Authorize(Policy = CorePolicies.Viewer)]
    public Task<SystemInfo> GetSystemInfo() => server.Info.GetAsync(Context.ConnectionAborted);

    [Authorize(Policy = CorePolicies.Viewer)]
    public async Task<ServiceInfo[]> ListServices() => [.. await server.Services.ListAsync(Context.ConnectionAborted)];

    [Authorize(Policy = CorePolicies.Viewer)]
    public async Task<MetricsHistory> GetMetricsHistory(MetricsHistoryRequest request)
    {
        if (request is null || !Enum.IsDefined(request.Resolution))
        {
            throw new HubException("Ask for live, minute or quarter-hour history.");
        }

        return await server.Metrics.HistoryAsync(request, Context.ConnectionAborted);
    }

    [Authorize(Policy = CorePolicies.Viewer)]
    public async IAsyncEnumerable<MetricsSample> StreamMetrics(
        MetricsStreamRequest request,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        using var lease = server.Streams.Open(Context.ConnectionId, StreamLimits.Metrics);
        var interval = MetricsSampler.ClampInterval(request?.IntervalMs);
        // Subscribed before the replay, so nothing taken in between is missed; repeats are skipped.
        using var subscription = server.Metrics.Subscribe(interval);
        long last = 0;
        if (request?.SinceUnixMs is long since)
        {
            foreach (var sample in server.Metrics.LiveSince(since))
            {
                if (last == 0 || sample.AtUnixMs - last >= interval.TotalMilliseconds * 0.9)
                {
                    last = sample.AtUnixMs;
                    yield return sample;
                }
            }
        }

        await foreach (var sample in subscription.Reader.ReadAllAsync(cancellationToken))
        {
            if (sample.AtUnixMs > last)
            {
                last = sample.AtUnixMs;
                yield return sample;
            }
        }
    }

    [Authorize(Policy = CorePolicies.Viewer)]
    public Task<UpdatesInfo> GetUpdates() => Task.FromResult(server.Updates.Current);

    [Authorize(Policy = CorePolicies.Viewer)]
    public Task<JobPage> ListJobs(JobQuery query) => server.Jobs.ListAsync(query ?? new JobQuery(), Context.ConnectionAborted);

    [Authorize(Policy = CorePolicies.Viewer)]
    public async Task<JobInfo> GetJob(Guid jobId) =>
        await server.Jobs.GetAsync(jobId, Context.ConnectionAborted) ?? throw new HubException("There is no such job.");

    [Authorize(Policy = CorePolicies.Viewer)]
    public async IAsyncEnumerable<JobStreamItem> StreamJob(
        Guid jobId,
        long afterSeq,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        using var lease = server.Streams.Open(Context.ConnectionId, StreamLimits.Job);
        if (afterSeq < 0)
        {
            throw new HubException("afterSeq is the last line received: 0 or more.");
        }

        if (await server.Jobs.GetAsync(jobId, cancellationToken) is null)
        {
            throw new HubException("There is no such job.");
        }

        await foreach (var item in server.Jobs.StreamAsync(jobId, afterSeq, cancellationToken))
        {
            yield return item;
        }
    }

    [Authorize(Policy = CorePolicies.Viewer)]
    public Task<AlertInfo[]> ListAlerts(AlertQuery query) => server.Alerts.ListAsync(query ?? new AlertQuery(), Context.ConnectionAborted);

    [Authorize(Policy = CorePolicies.Viewer)]
    public async IAsyncEnumerable<AlertInfo> StreamAlerts(
        AlertStreamRequest request,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        using var lease = server.Streams.Open(Context.ConnectionId, StreamLimits.Alerts);
        using var subscription = server.Alerts.Subscribe();
        var after = request?.AfterRevision;
        var last = after ?? 0;
        while (true)
        {
            var page = await server.Alerts.ChangesAfterAsync(after, AlertCenter.MaxListed, cancellationToken);
            foreach (var alert in page)
            {
                last = Math.Max(last, alert.Revision);
                yield return alert;
            }

            // Open alerts come in one page; changes after a revision may take several.
            if (after is null || page.Length < AlertCenter.MaxListed)
            {
                break;
            }

            after = last;
        }

        await foreach (var alert in subscription.Reader.ReadAllAsync(cancellationToken))
        {
            if (alert.Revision > last)
            {
                last = alert.Revision;
                yield return alert;
            }
        }
    }
}
