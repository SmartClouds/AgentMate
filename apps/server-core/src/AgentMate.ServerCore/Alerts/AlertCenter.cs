using System.Threading.Channels;
using AgentMate.ServerCore.Contracts;
using AgentMate.ServerCore.Data;
using AgentMate.ServerCore.Security;
using Microsoft.EntityFrameworkCore;

namespace AgentMate.ServerCore.Alerts;

/// <summary>A live feed of alert changes. Disposing it unsubscribes.</summary>
internal sealed class AlertSubscription(ChannelReader<AlertInfo> reader, Action unsubscribe) : IDisposable
{
    public ChannelReader<AlertInfo> Reader { get; } = reader;

    public void Dispose() => unsubscribe();
}

/// <summary>
/// Raises, resolves and acknowledges alerts, and tells subscribers about every change. An alert is
/// one condition on one resource while it lasts: raising it again moves its last-seen time and
/// count on. Every change takes the next revision inside a write transaction, so revisions only
/// ever go up and a client that remembers the highest one it saw can resume without gaps.
/// </summary>
internal sealed partial class AlertCenter(
    IDbContextFactory<CoreDbContext> contexts,
    TimeProvider time,
    Redactor redactor,
    ILogger<AlertCenter> logger) : IDisposable
{
    /// <summary>Changes a subscriber may fall behind by before its stream is ended.</summary>
    public const int SubscriberBuffer = 256;

    public const int MaxListed = 500;

    public static readonly TimeSpan KeepResolved = TimeSpan.FromDays(30);

    private const int MaxMessageLength = 1000;

    private readonly SemaphoreSlim _gate = new(1, 1);

    private readonly Lock _subscribersGate = new();

    private readonly List<Channel<AlertInfo>> _subscribers = [];

    private long Now => time.GetUtcNow().ToUnixTimeMilliseconds();

    /// <summary>
    /// Opens the alert, or updates the open one. Getting worse (a higher severity) clears an
    /// acknowledgment: whoever quieted a warning has not seen the critical.
    /// </summary>
    public async Task<AlertInfo> RaiseAsync(
        AlertKind kind,
        string resource,
        AlertSeverity severity,
        string message,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(resource);
        ArgumentNullException.ThrowIfNull(message);
        var safe = Clip(redactor.Redact(message));
        var raised = await WriteAsync(
            async db =>
            {
                var now = Now;
                var open = await OpenQuery(db, kind, resource).FirstOrDefaultAsync(cancellationToken);
                if (open is null)
                {
                    open = new Alert
                    {
                        Kind = kind,
                        Severity = severity,
                        Resource = resource,
                        Message = safe,
                        FirstSeenAt = now,
                        LastSeenAt = now,
                        Occurrences = 1,
                    };
                    db.Alerts.Add(open);
                    return open;
                }

                if (severity > open.Severity)
                {
                    open.AcknowledgedAt = null;
                    open.AcknowledgedBy = null;
                    open.AcknowledgedByName = null;
                }

                open.Severity = severity;
                open.Message = safe;
                open.LastSeenAt = now;
                open.Occurrences++;
                return open;
            },
            cancellationToken);
        return raised!;
    }

    /// <summary>The condition cleared. Null when nothing was open.</summary>
    public Task<AlertInfo?> ResolveAsync(AlertKind kind, string resource, CancellationToken cancellationToken = default) =>
        WriteAsync(
            async db =>
            {
                var open = await OpenQuery(db, kind, resource).FirstOrDefaultAsync(cancellationToken);
                if (open is not null)
                {
                    open.ResolvedAt = Now;
                }

                return open;
            },
            cancellationToken);

    /// <summary>Null when there is no such alert. Acknowledging twice changes nothing.</summary>
    public Task<AlertInfo?> AcknowledgeAsync(long id, Guid userId, string userName, CancellationToken cancellationToken = default) =>
        WriteAsync(
            async db =>
            {
                var alert = await db.Alerts.FirstOrDefaultAsync(a => a.Id == id, cancellationToken);
                if (alert is not null && alert.AcknowledgedAt is null)
                {
                    alert.AcknowledgedAt = Now;
                    alert.AcknowledgedBy = userId;
                    alert.AcknowledgedByName = userName;
                }

                return alert;
            },
            cancellationToken);

    /// <summary>Newest change first.</summary>
    public async Task<AlertInfo[]> ListAsync(AlertQuery query, CancellationToken cancellationToken = default)
    {
        var limit = Math.Clamp(query?.Limit ?? 100, 1, MaxListed);
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var alerts = db.Alerts.AsNoTracking();
        if (query?.IncludeResolved != true)
        {
            alerts = alerts.Where(a => a.ResolvedAt == null);
        }

        return [.. (await alerts.OrderByDescending(a => a.Revision).Take(limit).ToListAsync(cancellationToken)).Select(ToInfo)];
    }

    /// <summary>
    /// What a stream starts with, oldest change first: every open alert when no revision is given,
    /// otherwise every alert changed after that revision, resolved ones included.
    /// </summary>
    public async Task<AlertInfo[]> ChangesAfterAsync(long? afterRevision, int limit, CancellationToken cancellationToken = default)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var alerts = afterRevision is long after
            ? db.Alerts.AsNoTracking().Where(a => a.Revision > after)
            : db.Alerts.AsNoTracking().Where(a => a.ResolvedAt == null);
        return [.. (await alerts.OrderBy(a => a.Revision).Take(Math.Clamp(limit, 1, MaxListed)).ToListAsync(cancellationToken)).Select(ToInfo)];
    }

    /// <summary>The revision of the last change so far, or 0 before any.</summary>
    public async Task<long> LatestRevisionAsync(CancellationToken cancellationToken = default)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        return await db.Alerts.MaxAsync(a => (long?)a.Revision, cancellationToken) ?? 0;
    }

    public async Task<AlertInfo[]> OpenAsync(AlertKind kind, CancellationToken cancellationToken = default)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        return [.. (await db.Alerts.AsNoTracking()
            .Where(a => a.Kind == kind && a.ResolvedAt == null)
            .ToListAsync(cancellationToken)).Select(ToInfo)];
    }

    /// <summary>
    /// Every change from now on, in revision order. A subscriber that falls more than
    /// <see cref="SubscriberBuffer"/> changes behind is let go: its reader completes, and it
    /// subscribes again from the last revision it received instead of holding memory without end.
    /// </summary>
    public AlertSubscription Subscribe()
    {
        var channel = Channel.CreateBounded<AlertInfo>(new BoundedChannelOptions(SubscriberBuffer)
        {
            SingleReader = true,
            FullMode = BoundedChannelFullMode.Wait,
        });
        lock (_subscribersGate)
        {
            _subscribers.Add(channel);
        }

        return new AlertSubscription(channel.Reader, () =>
        {
            lock (_subscribersGate)
            {
                _subscribers.Remove(channel);
            }

            channel.Writer.TryComplete();
        });
    }

    /// <summary>Resolved alerts older than the cutoff. Open ones stay whatever their age.</summary>
    public async Task<int> PruneAsync(DateTimeOffset cutoff, CancellationToken cancellationToken = default)
    {
        var cutoffMs = cutoff.ToUnixTimeMilliseconds();
        await _gate.WaitAsync(cancellationToken);
        try
        {
            await using var db = await contexts.CreateDbContextAsync(cancellationToken);
            return await db.Alerts
                .Where(a => a.ResolvedAt != null && a.ResolvedAt < cutoffMs)
                .ExecuteDeleteAsync(cancellationToken);
        }
        finally
        {
            _gate.Release();
        }
    }

    public void Dispose() => _gate.Dispose();

    private static IQueryable<Alert> OpenQuery(CoreDbContext db, AlertKind kind, string resource) =>
        db.Alerts.Where(a => a.Kind == kind && a.Resource == resource && a.ResolvedAt == null);

    /// <summary>
    /// Applies a change under the write lock and gives it the next revision. Subscribers hear of it
    /// before the lock is let go, so they always hear changes in revision order.
    /// </summary>
    private async Task<AlertInfo?> WriteAsync(Func<CoreDbContext, Task<Alert?>> change, CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            await using var db = await contexts.CreateDbContextAsync(cancellationToken);
            await using var transaction = await CoreDatabase.BeginWriteAsync(db, cancellationToken);
            var alert = await change(db);
            if (alert is null)
            {
                return null;
            }

            if (!db.ChangeTracker.HasChanges())
            {
                return ToInfo(alert);
            }

            alert.Revision = (await db.Alerts.MaxAsync(a => (long?)a.Revision, cancellationToken) ?? 0) + 1;
            await db.SaveChangesAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            var info = ToInfo(alert);
            Publish(info);
            return info;
        }
        finally
        {
            _gate.Release();
        }
    }

    private void Publish(AlertInfo info)
    {
        lock (_subscribersGate)
        {
            for (var i = _subscribers.Count - 1; i >= 0; i--)
            {
                var channel = _subscribers[i];
                if (!channel.Writer.TryWrite(info))
                {
                    channel.Writer.TryComplete();
                    _subscribers.RemoveAt(i);
                    LogSubscriberDropped(logger);
                }
            }
        }
    }

    private static string Clip(string message) =>
        message.Length <= MaxMessageLength ? message : message[..(MaxMessageLength - 1)] + "…";

    private static AlertInfo ToInfo(Alert alert) => new(
        alert.Id,
        alert.Revision,
        alert.Kind,
        alert.Severity,
        alert.Resource,
        alert.Message,
        alert.FirstSeenAt,
        alert.LastSeenAt,
        alert.Occurrences,
        alert.AcknowledgedAt,
        alert.AcknowledgedByName,
        alert.ResolvedAt);

    [LoggerMessage(Level = LogLevel.Information, Message = "An alert subscriber fell too far behind; its stream was ended so it can resubscribe.")]
    private static partial void LogSubscriberDropped(ILogger logger);
}
