using System.Globalization;
using AgentMate.ServerCore.Docker;

namespace AgentMate.ServerCore.Alerts;

/// <summary>What the detector found about one container.</summary>
internal abstract record CrashLoopChange(string Container);

/// <summary>The container is in a crash loop: it exited this many times inside the window.</summary>
internal sealed record CrashLoopRaised(string Container, int Crashes, string ExitCode) : CrashLoopChange(Container)
{
    public string Message =>
        $"{Container} keeps restarting: it exited {Crashes.ToString(CultureInfo.InvariantCulture)} times in the last {CrashLoopDetector.Window.TotalMinutes.ToString(CultureInfo.InvariantCulture)} minutes, the last time with exit code {ExitCode}.";
}

/// <summary>The container was in a crash loop and is not any more.</summary>
internal sealed record CrashLoopCleared(string Container) : CrashLoopChange(Container);

/// <summary>
/// Spots containers that keep crashing from Docker's events (E30). A crash is a "die" with a non-zero
/// exit code that nobody asked for: a stop or kill just before it means a person or a deploy did it.
/// <see cref="Threshold"/> crashes inside <see cref="Window"/> make a loop, and a loop clears after a
/// whole window without a crash, or when the container is removed. Containers are known by name,
/// which stays the same when compose recreates them. Not thread-safe: one watcher feeds it.
/// </summary>
internal sealed class CrashLoopDetector(TimeProvider time)
{
    public const int Threshold = 3;

    public static readonly TimeSpan Window = TimeSpan.FromMinutes(10);

    /// <summary>How long after a stop or kill an exit still counts as asked for.</summary>
    public static readonly TimeSpan StopGrace = TimeSpan.FromSeconds(60);

    private readonly Dictionary<string, Tracked> _containers = new(StringComparer.Ordinal);

    private DateTimeOffset Now => time.GetUtcNow();

    public CrashLoopChange? Observe(EngineEvent engineEvent)
    {
        ArgumentNullException.ThrowIfNull(engineEvent);
        if (engineEvent.Type != "container" || !engineEvent.Attributes.TryGetValue("name", out var name) || name.Length == 0)
        {
            return null;
        }

        switch (engineEvent.Action)
        {
            case "kill" or "stop":
                TrackedOf(name).AskedToStopAt = Now;
                return null;
            case "destroy":
                var wasLooping = _containers.Remove(name, out var gone) && gone.Looping;
                return wasLooping ? new CrashLoopCleared(name) : null;
            case "die":
                return Died(name, engineEvent.Attributes.GetValueOrDefault("exitCode", "0"));
            default:
                return null;
        }
    }

    /// <summary>Loops that have been quiet a whole window, cleared now. Call it now and then.</summary>
    public IReadOnlyList<CrashLoopCleared> Sweep()
    {
        var cutoff = Now - Window;
        var cleared = new List<CrashLoopCleared>();
        foreach (var (name, tracked) in _containers)
        {
            tracked.Crashes.RemoveAll(at => at < cutoff);
            if (tracked.Looping && tracked.LastCrashAt < cutoff)
            {
                tracked.Looping = false;
                cleared.Add(new CrashLoopCleared(name));
            }
        }

        foreach (var name in _containers.Where(c => c.Value is { Looping: false, Crashes.Count: 0 }).Select(c => c.Key).ToList())
        {
            _containers.Remove(name);
        }

        return cleared;
    }

    /// <summary>A loop still open from before the core started: it clears like any other once it has been quiet.</summary>
    public void Assume(string container)
    {
        var tracked = TrackedOf(container);
        tracked.Looping = true;
        tracked.LastCrashAt = Now;
    }

    private CrashLoopRaised? Died(string name, string exitCode)
    {
        var tracked = TrackedOf(name);
        var askedFor = tracked.AskedToStopAt is { } stoppedAt && Now - stoppedAt <= StopGrace;
        tracked.AskedToStopAt = null;
        if (askedFor || exitCode == "0")
        {
            return null;
        }

        var now = Now;
        tracked.Crashes.RemoveAll(at => at < now - Window);
        tracked.Crashes.Add(now);
        tracked.LastCrashAt = now;
        if (tracked.Crashes.Count < Threshold)
        {
            return null;
        }

        tracked.Looping = true;
        return new CrashLoopRaised(name, tracked.Crashes.Count, exitCode);
    }

    private Tracked TrackedOf(string name)
    {
        if (!_containers.TryGetValue(name, out var tracked))
        {
            tracked = new Tracked();
            _containers[name] = tracked;
        }

        return tracked;
    }

    private sealed class Tracked
    {
        public List<DateTimeOffset> Crashes { get; } = [];

        public DateTimeOffset? AskedToStopAt { get; set; }

        public DateTimeOffset LastCrashAt { get; set; }

        public bool Looping { get; set; }
    }
}
