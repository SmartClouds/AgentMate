using AgentMate.ServerCore.Alerts;
using AgentMate.ServerCore.Docker;
using Microsoft.Extensions.Time.Testing;

namespace AgentMate.ServerCore.Tests;

/// <summary>
/// A container is in a crash loop when it exits on its own, again and again, in a short time: three
/// crashes inside ten minutes. Stopping it by hand, a clean exit, or another container's crashes do
/// not count, and ten quiet minutes, a minute up after a start, or removing it clear it.
/// </summary>
public sealed class CrashLoopDetectorTests
{
    private readonly FakeTimeProvider _clock = new(DateTimeOffset.FromUnixTimeMilliseconds(1_800_000_000_000));

    private readonly CrashLoopDetector _detector;

    public CrashLoopDetectorTests() => _detector = new CrashLoopDetector(_clock);

    private static EngineEvent Event(string action, string container = "shop-api-1", params (string Name, string Value)[] extra)
    {
        var attributes = new Dictionary<string, string>(StringComparer.Ordinal) { ["name"] = container };
        foreach (var (name, value) in extra)
        {
            attributes[name] = value;
        }

        return new EngineEvent("container", action, "id-" + container, 0, attributes);
    }

    private CrashLoopChange? Crash(string container = "shop-api-1", string exitCode = "1")
    {
        _clock.Advance(TimeSpan.FromSeconds(20));
        return _detector.Observe(Event("die", container, ("exitCode", exitCode)));
    }

    [Fact]
    public void Two_crashes_are_not_a_loop_and_the_third_is()
    {
        Assert.Null(Crash());
        Assert.Null(Crash());

        var raised = Assert.IsType<CrashLoopRaised>(Crash(exitCode: "137"));

        Assert.Equal("shop-api-1", raised.Container);
        Assert.Equal(3, raised.Crashes);
        Assert.Equal("shop-api-1 keeps restarting: it exited 3 times in the last 10 minutes, the last time with exit code 137.", raised.Message);
    }

    [Fact]
    public void Every_crash_after_that_raises_again_with_the_new_count()
    {
        Crash();
        Crash();
        Crash();

        Assert.Equal(4, Assert.IsType<CrashLoopRaised>(Crash()).Crashes);
    }

    [Fact]
    public void Crashes_further_apart_than_the_window_are_not_a_loop()
    {
        Crash();
        _clock.Advance(TimeSpan.FromMinutes(6));
        Crash();
        _clock.Advance(TimeSpan.FromMinutes(6));

        Assert.Null(Crash());
    }

    [Fact]
    public void A_clean_exit_does_not_count()
    {
        Crash();
        Crash();

        Assert.Null(Crash(exitCode: "0"));
    }

    [Fact]
    public void Stopping_or_killing_it_on_purpose_does_not_count()
    {
        Crash();
        Crash();
        _detector.Observe(Event("kill", extra: ("signal", "15")));
        Assert.Null(Crash(exitCode: "143"));

        _detector.Observe(Event("stop"));
        Assert.Null(Crash(exitCode: "137"));
    }

    [Fact]
    public void A_stop_long_ago_does_not_hide_a_later_crash()
    {
        Crash();
        Crash();
        _detector.Observe(Event("kill"));
        _clock.Advance(TimeSpan.FromMinutes(2));
        Crash(exitCode: "143");

        Assert.IsType<CrashLoopRaised>(Crash());
    }

    [Fact]
    public void Each_container_is_counted_on_its_own()
    {
        Crash("a");
        Crash("b");
        Crash("a");
        Crash("b");

        Assert.Equal("a", Assert.IsType<CrashLoopRaised>(Crash("a")).Container);
    }

    [Fact]
    public void Ten_quiet_minutes_clear_it()
    {
        Crash();
        Crash();
        Crash();
        _clock.Advance(TimeSpan.FromMinutes(9));
        Assert.Empty(_detector.Sweep());

        _clock.Advance(TimeSpan.FromMinutes(2));

        Assert.Equal("shop-api-1", Assert.Single(_detector.Sweep()).Container);
        Assert.Empty(_detector.Sweep());
    }

    [Fact]
    public void Staying_up_a_minute_after_a_start_clears_it()
    {
        Crash();
        Crash();
        Crash();
        _detector.Observe(Event("start"));
        _clock.Advance(TimeSpan.FromSeconds(50));
        Assert.Empty(_detector.Sweep());

        _clock.Advance(TimeSpan.FromSeconds(10));

        Assert.Equal("shop-api-1", Assert.Single(_detector.Sweep()).Container);
        Assert.Empty(_detector.Sweep());
    }

    [Fact]
    public void After_staying_up_the_count_starts_again()
    {
        Crash();
        Crash();
        Crash();
        _detector.Observe(Event("start"));
        _clock.Advance(TimeSpan.FromMinutes(1));
        _detector.Sweep();

        Assert.Null(Crash());
        Assert.Null(Crash());
        Assert.IsType<CrashLoopRaised>(Crash());
    }

    [Fact]
    public void A_start_that_crashes_again_does_not_clear_it()
    {
        Crash();
        Crash();
        Crash();
        _detector.Observe(Event("start"));
        Crash();
        _clock.Advance(TimeSpan.FromMinutes(2));

        Assert.Empty(_detector.Sweep());
    }

    [Fact]
    public void Staying_up_does_not_forget_crashes_short_of_a_loop()
    {
        Crash();
        Crash();
        _detector.Observe(Event("start"));
        _clock.Advance(TimeSpan.FromMinutes(2));
        _detector.Sweep();

        Assert.IsType<CrashLoopRaised>(Crash());
    }

    [Fact]
    public void Removing_the_container_clears_it_at_once()
    {
        Crash();
        Crash();
        Crash();

        Assert.IsType<CrashLoopCleared>(_detector.Observe(Event("destroy")));
        Assert.Empty(_detector.Sweep());
    }

    [Fact]
    public void Removing_a_container_that_was_fine_clears_nothing()
    {
        Crash();

        Assert.Null(_detector.Observe(Event("destroy")));
    }

    [Fact]
    public void A_loop_left_open_from_before_a_restart_clears_after_ten_quiet_minutes()
    {
        _detector.Assume("shop-api-1");
        _clock.Advance(TimeSpan.FromMinutes(11));

        Assert.Equal("shop-api-1", Assert.Single(_detector.Sweep()).Container);
    }

    [Fact]
    public void Other_kinds_of_event_are_ignored()
    {
        Assert.Null(_detector.Observe(new EngineEvent("image", "die", "x", 0, new Dictionary<string, string>(StringComparer.Ordinal) { ["exitCode"] = "1" })));
        Assert.Null(_detector.Observe(new EngineEvent("container", "die", "x", 0, new Dictionary<string, string>(StringComparer.Ordinal))));
    }
}
