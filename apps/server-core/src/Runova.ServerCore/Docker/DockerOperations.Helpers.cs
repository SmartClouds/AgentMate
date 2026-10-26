using System.Globalization;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Jobs;

namespace Runova.ServerCore.Docker;

/// <summary>
/// Follows the stats streams of several containers at once and keeps each one's newest sample.
/// A container whose stream ends (it stopped, or was removed) is reported once as stopped.
/// </summary>
internal sealed class StatsWatch(IDockerEngine engine, CancellationToken cancellationToken) : IAsyncDisposable
{
    private readonly Lock _gate = new();
    private readonly Dictionary<string, Task> _readers = new(StringComparer.Ordinal);
    private readonly Dictionary<string, ContainerStatsSample> _latest = new(StringComparer.Ordinal);
    private readonly List<string> _stopped = [];
    private volatile bool _engineLost;

    /// <summary>The engine stopped answering; the stream should end so the app opens it again.</summary>
    public bool EngineLost => _engineLost;

    public void Follow(IEnumerable<string> containerIds)
    {
        lock (_gate)
        {
            foreach (var id in containerIds)
            {
                if (!_readers.ContainsKey(id))
                {
                    _readers[id] = Task.Run(() => ReadAsync(id), CancellationToken.None);
                }
            }
        }
    }

    public (List<ContainerStatsSample> Samples, List<string> Stopped) Drain()
    {
        lock (_gate)
        {
            var samples = _latest.Values.OrderBy(sample => sample.ContainerId, StringComparer.Ordinal).ToList();
            var stopped = _stopped.ToList();
            _latest.Clear();
            _stopped.Clear();
            return (samples, stopped);
        }
    }

    public async ValueTask DisposeAsync()
    {
        Task[] readers;
        lock (_gate)
        {
            readers = [.. _readers.Values];
        }

        await Task.WhenAll(readers);
    }

    private async Task ReadAsync(string id)
    {
        try
        {
            await foreach (var reading in engine.StreamStatsAsync(id, cancellationToken))
            {
                var sample = DockerStatsMath.Sample(id, reading, reading.ReadAt.ToUnixTimeMilliseconds());
                lock (_gate)
                {
                    _latest[id] = sample;
                }
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return;
        }
        catch (DockerUnavailableException)
        {
            _engineLost = true;
        }
        catch (Exception error) when (error is DockerNotFoundException or DockerRequestException)
        {
            // Gone or never there: reported as stopped below.
        }

        lock (_gate)
        {
            _readers.Remove(id);
            _stopped.Add(id);
        }
    }
}

/// <summary>
/// A pull's progress in the job's log: each layer's status when it changes, and while it
/// downloads or extracts at most every two seconds, so a big image does not flood the log.
/// </summary>
internal sealed class PullLog(JobContext job, TimeProvider time)
{
    private static readonly TimeSpan _every = TimeSpan.FromSeconds(2);

    private readonly Dictionary<string, (string Status, DateTimeOffset At)> _layers = new(StringComparer.Ordinal);

    public void Report(PullProgress progress)
    {
        ArgumentNullException.ThrowIfNull(progress);
        if (progress.Error is { Length: > 0 } error)
        {
            job.Log(error, JobLogSource.Err);
            return;
        }

        if (progress.Status is not { Length: > 0 } status)
        {
            return;
        }

        if (progress.Layer is not { Length: > 0 } layer)
        {
            job.Log(status, JobLogSource.Out);
            return;
        }

        var now = time.GetUtcNow();
        var moving = status is "Downloading" or "Extracting";
        if (_layers.TryGetValue(layer, out var last) && last.Status == status && (!moving || now - last.At < _every))
        {
            return;
        }

        _layers[layer] = (status, now);
        job.Log(
            progress.Current is long current && progress.Total is long total and > 0
                ? $"{layer}: {status} {Size(current)} of {Size(total)}"
                : $"{layer}: {status}",
            JobLogSource.Out);
    }

    private static string Size(long bytes) => bytes switch
    {
        >= 1_000_000_000 => (bytes / 1e9).ToString("0.0", CultureInfo.InvariantCulture) + " GB",
        >= 1_000_000 => (bytes / 1e6).ToString("0.0", CultureInfo.InvariantCulture) + " MB",
        >= 1_000 => (bytes / 1e3).ToString("0.0", CultureInfo.InvariantCulture) + " kB",
        _ => bytes.ToString(CultureInfo.InvariantCulture) + " B",
    };
}
