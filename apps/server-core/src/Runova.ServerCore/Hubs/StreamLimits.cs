using Microsoft.AspNetCore.SignalR;

namespace Runova.ServerCore.Hubs;

/// <summary>
/// How many streams one connection may hold open at once, per kind and in all. Each stream holds a
/// subscription or a file handle on the server, so a client opening them in a loop is refused
/// instead of growing the core's memory. Open streams do not block ordinary calls: SignalR counts
/// them apart from the parallel invocations.
/// </summary>
internal sealed class StreamLimits
{
    public const string Metrics = "metrics";

    public const string Job = "job";

    public const string Alerts = "alerts";

    // Docker (E06).
    public const string ContainerStats = "container-stats";

    public const string ContainerLogs = "container-logs";

    public const string DockerEvents = "docker-events";

    public const string Console = "console";

    public const string SiteLog = "site-log";

    // Logs center and Deploy AI (E09).
    public const string Exec = "exec";

    public const string Journal = "journal";

    public const int PerConnection = 8;

    public static readonly IReadOnlyDictionary<string, int> PerKind = new Dictionary<string, int>(StringComparer.Ordinal)
    {
        [Metrics] = 2,
        [Job] = 4,
        [Alerts] = 2,
        [ContainerStats] = 2,
        [ContainerLogs] = 4,
        [DockerEvents] = 2,
        [Console] = 2,
        [SiteLog] = 2,
        [Exec] = 2,
        [Journal] = 2,
    };

    private readonly Lock _gate = new();
    private readonly Dictionary<string, Dictionary<string, int>> _open = new(StringComparer.Ordinal);

    /// <summary>Counts a new stream, or refuses it; dispose the lease when the stream ends.</summary>
    public IDisposable Open(string connectionId, string kind)
    {
        ArgumentNullException.ThrowIfNull(connectionId);
        var limit = PerKind.TryGetValue(kind, out var perKind)
            ? perKind
            : throw new ArgumentOutOfRangeException(nameof(kind), $"There is no stream kind {kind}.");
        lock (_gate)
        {
            if (!_open.TryGetValue(connectionId, out var counts))
            {
                counts = new Dictionary<string, int>(StringComparer.Ordinal);
                _open[connectionId] = counts;
            }

            if (counts.GetValueOrDefault(kind) >= limit)
            {
                throw new HubException($"This connection already has {limit} {kind} streams open. Close one before opening another.");
            }

            if (counts.Values.Sum() >= PerConnection)
            {
                throw new HubException($"This connection already has {PerConnection} streams open. Close one before opening another.");
            }

            counts[kind] = counts.GetValueOrDefault(kind) + 1;
        }

        return new Lease(this, connectionId, kind);
    }

    public int OpenCount(string connectionId)
    {
        lock (_gate)
        {
            return _open.TryGetValue(connectionId, out var counts) ? counts.Values.Sum() : 0;
        }
    }

    /// <summary>The connection is gone; whatever it still counted goes with it.</summary>
    public void Forget(string connectionId)
    {
        lock (_gate)
        {
            _open.Remove(connectionId);
        }
    }

    private void Close(string connectionId, string kind)
    {
        lock (_gate)
        {
            if (!_open.TryGetValue(connectionId, out var counts) || !counts.TryGetValue(kind, out var count))
            {
                return;
            }

            if (count <= 1)
            {
                counts.Remove(kind);
            }
            else
            {
                counts[kind] = count - 1;
            }

            if (counts.Count == 0)
            {
                _open.Remove(connectionId);
            }
        }
    }

    private sealed class Lease(StreamLimits limits, string connectionId, string kind) : IDisposable
    {
        private int _disposed;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 0)
            {
                limits.Close(connectionId, kind);
            }
        }
    }
}
