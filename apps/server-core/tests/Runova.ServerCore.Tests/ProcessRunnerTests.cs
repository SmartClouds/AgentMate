using System.Diagnostics;
using System.Globalization;
using Runova.ServerCore.Execution;

namespace Runova.ServerCore.Tests;

/// <summary>
/// Every program the core starts goes through the process runner: an argument list (never a shell
/// string), an environment it spells out rather than inherits, a time limit and a cap on the
/// output it keeps. When a run times out or is cancelled, everything it started goes with it.
/// </summary>
public sealed class ProcessRunnerTests
{
    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private static readonly ProcessRunner _runner = new(TimeProvider.System);

    private static string WindowsTool(string name) =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), name);

    /// <summary>A command that prints "hello" and exits with the given code.</summary>
    private static ProcessSpec HelloThenExit(int code) => OperatingSystem.IsWindows()
        ? new ProcessSpec { Program = WindowsTool("cmd.exe"), Arguments = ["/d", "/c", $"echo hello& exit {code}"] }
        : new ProcessSpec { Program = "sh", Arguments = ["-c", $"echo hello; exit {code}"] };

    private static ProcessSpec SleepFor(int seconds) => OperatingSystem.IsWindows()
        ? new ProcessSpec
        {
            Program = WindowsTool("PING.EXE"),
            Arguments = ["-n", (seconds + 1).ToString(CultureInfo.InvariantCulture), "127.0.0.1"],
        }
        : new ProcessSpec { Program = "sleep", Arguments = [seconds.ToString(CultureInfo.InvariantCulture)] };

    [Fact]
    public async Task A_run_reports_the_exit_code_and_the_output()
    {
        var result = await _runner.RunAsync(HelloThenExit(3), cancellationToken: Cancel);

        Assert.Equal(3, result.ExitCode);
        Assert.Equal("hello", result.StandardOutput.Trim());
        Assert.False(result.TimedOut);
        Assert.False(result.Succeeded);
    }

    [Fact]
    public async Task Output_lines_arrive_as_they_are_written()
    {
        var lines = new List<OutputLine>();

        var result = await _runner.RunAsync(HelloThenExit(0), line => lines.Add(line), Cancel);

        Assert.True(result.Succeeded);
        Assert.Equal(new OutputLine(OutputStream.Out, "hello"), Assert.Single(lines, line => line.Text.Length > 0));
    }

    [Fact]
    public async Task Arguments_reach_the_program_exactly_as_given()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "POSIX sh");
        string[] awkward = ["two words", "$HOME", "; rm -rf /", "\"quoted\"", "*"];

        var result = await _runner.RunAsync(
            new ProcessSpec { Program = "sh", Arguments = ["-c", "printf '%s\\n' \"$@\"", "sh", .. awkward] },
            cancellationToken: Cancel);

        Assert.Equal(awkward, result.StandardOutput.TrimEnd('\n').Split('\n'));
    }

    [Fact]
    public async Task The_environment_is_only_what_the_runner_sets()
    {
        Environment.SetEnvironmentVariable("RUNOVA_TEST_LEAK", "leaked");
        var spec = OperatingSystem.IsWindows()
            ? new ProcessSpec { Program = WindowsTool("cmd.exe"), Arguments = ["/d", "/c", "set"] }
            : new ProcessSpec { Program = "env" };

        var result = await _runner.RunAsync(
            spec with { Environment = new Dictionary<string, string> { ["RUNOVA_GIVEN"] = "given" } },
            cancellationToken: Cancel);

        Assert.Contains("RUNOVA_GIVEN=given", result.StandardOutput, StringComparison.Ordinal);
        Assert.DoesNotContain("RUNOVA_TEST_LEAK", result.StandardOutput, StringComparison.Ordinal);
        if (!OperatingSystem.IsWindows())
        {
            Assert.Contains("LC_ALL=C", result.StandardOutput, StringComparison.Ordinal);
        }
    }

    [Fact]
    public async Task Standard_input_is_written_and_then_closed()
    {
        var spec = OperatingSystem.IsWindows()
            ? new ProcessSpec { Program = WindowsTool("sort.exe") }
            : new ProcessSpec { Program = "cat" };

        var result = await _runner.RunAsync(spec with { StandardInput = "from stdin\n" }, cancellationToken: Cancel);

        Assert.Equal("from stdin", result.StandardOutput.Trim());
    }

    [Fact]
    public async Task Every_line_is_read_before_the_result_even_when_reading_is_slow()
    {
        // The program is long gone while the first line is still being handled. Its output is all
        // in the pipe, so the result waits for it, however long the reader takes to get there.
        var spec = OperatingSystem.IsWindows()
            ? new ProcessSpec { Program = WindowsTool("cmd.exe"), Arguments = ["/d", "/c", "echo one& echo two"] }
            : new ProcessSpec { Program = "sh", Arguments = ["-c", "printf 'one\\ntwo\\n'"] };
        var lines = new System.Collections.Concurrent.ConcurrentQueue<string>();

        var result = await _runner.RunAsync(
            spec,
            line =>
            {
                lines.Enqueue(line.Text);
                if (line.Text.Trim() == "one")
                {
                    Thread.Sleep(TimeSpan.FromSeconds(4));
                }
            },
            Cancel);

        Assert.Equal(["one", "two"], result.StandardOutput.Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(text => text.Trim()));
        Assert.Equal(["one", "two"], lines.Select(text => text.Trim()).Where(text => text.Length > 0));
    }

    [Fact]
    public async Task A_background_child_holding_the_output_does_not_hold_the_result()
    {
        Assert.SkipUnless(OperatingSystem.IsLinux(), "Linux process groups");
        var started = TimeProvider.System.GetTimestamp();

        var result = await _runner.RunAsync(
            new ProcessSpec { Program = "sh", Arguments = ["-c", "echo started; sleep 30 &"] },
            cancellationToken: Cancel);

        Assert.Equal(0, result.ExitCode);
        Assert.Equal("started", result.StandardOutput.Trim());
        Assert.True(TimeProvider.System.GetElapsedTime(started) < TimeSpan.FromSeconds(15));
    }

    [Fact]
    public async Task A_daemon_that_left_the_group_with_the_output_is_not_waited_for()
    {
        Assert.SkipUnless(OperatingSystem.IsLinux(), "Linux sessions");
        var pidFile = Path.GetTempFileName();
        var started = TimeProvider.System.GetTimestamp();
        try
        {
            // setsid puts the sleep in a session of its own, out of reach of the run's group kill.
            var result = await _runner.RunAsync(
                new ProcessSpec { Program = "sh", Arguments = ["-c", "setsid sleep 60 & echo $! > \"$1\"", "sh", pidFile] },
                cancellationToken: Cancel);
            var elapsed = TimeProvider.System.GetElapsedTime(started);

            Assert.Equal(0, result.ExitCode);
            Assert.True(elapsed < TimeSpan.FromSeconds(45));
        }
        finally
        {
            if (int.TryParse(File.ReadAllText(pidFile).Trim(), CultureInfo.InvariantCulture, out var pid))
            {
                using var daemon = Process.GetProcessById(pid);
                daemon.Kill();
            }

            File.Delete(pidFile);
        }
    }

    [Fact]
    public async Task Output_beyond_the_cap_is_dropped_and_flagged()
    {
        var spec = OperatingSystem.IsWindows()
            ? new ProcessSpec { Program = WindowsTool("cmd.exe"), Arguments = ["/d", "/c", "for /l %i in (1,1,3000) do @echo line %i"] }
            : new ProcessSpec { Program = "seq", Arguments = ["1", "30000"] };

        var result = await _runner.RunAsync(spec with { MaxOutputBytes = 1000 }, cancellationToken: Cancel);

        Assert.True(result.OutputTruncated);
        Assert.InRange(result.StandardOutput.Length, 1, 1000);
    }

    [Fact]
    public async Task A_run_past_its_time_limit_is_killed()
    {
        var started = TimeProvider.System.GetTimestamp();

        var result = await _runner.RunAsync(SleepFor(30) with { Timeout = TimeSpan.FromMilliseconds(500) }, cancellationToken: Cancel);

        Assert.True(result.TimedOut);
        Assert.False(result.Succeeded);
        Assert.True(TimeProvider.System.GetElapsedTime(started) < TimeSpan.FromSeconds(15));
    }

    [Fact]
    public async Task Cancelling_a_run_kills_it_and_throws()
    {
        using var cancel = CancellationTokenSource.CreateLinkedTokenSource(Cancel);
        cancel.CancelAfter(TimeSpan.FromMilliseconds(300));
        var started = TimeProvider.System.GetTimestamp();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => _runner.RunAsync(SleepFor(30), cancellationToken: cancel.Token));

        Assert.True(TimeProvider.System.GetElapsedTime(started) < TimeSpan.FromSeconds(15));
    }

    [Fact]
    public async Task A_timeout_kills_every_process_the_run_started()
    {
        Assert.SkipUnless(OperatingSystem.IsLinux(), "Linux process groups");
        var marker = $"runova-group-{Guid.NewGuid():N}";
        var spec = new ProcessSpec
        {
            Program = "sh",
            Arguments = ["-c", "sleep 30 & sleep 30 & wait", marker],
            Timeout = TimeSpan.FromMilliseconds(500),
        };
        int? group = null;

        var result = await _runner.RunAsync(spec, onLine: null, started: pid => group = pid, Cancel);

        Assert.True(result.TimedOut);
        Assert.NotNull(group);
        // Every member of the run's process group is gone, the backgrounded sleeps included.
        await WaitUntilAsync(() => ProcessesInGroup(group.Value).Count == 0);
        Assert.Empty(ProcessesInGroup(group.Value));
    }

    [Theory]
    [InlineData("bin/tool")]
    [InlineData("./tool")]
    [InlineData("")]
    [InlineData("tool name")]
    public async Task Programs_are_absolute_paths_or_plain_names(string program)
    {
        await Assert.ThrowsAsync<ArgumentException>(() =>
            _runner.RunAsync(new ProcessSpec { Program = program }, cancellationToken: Cancel));
    }

    [Fact]
    public async Task Arguments_and_environment_are_checked_before_anything_runs()
    {
        await Assert.ThrowsAsync<ArgumentException>(() =>
            _runner.RunAsync(new ProcessSpec { Program = "sh", Arguments = ["a\0b"] }, cancellationToken: Cancel));
        await Assert.ThrowsAsync<ArgumentException>(() =>
            _runner.RunAsync(
                new ProcessSpec { Program = "sh", Environment = new Dictionary<string, string> { ["BAD NAME"] = "x" } },
                cancellationToken: Cancel));
        await Assert.ThrowsAsync<ArgumentException>(() =>
            _runner.RunAsync(new ProcessSpec { Program = "sh", Timeout = TimeSpan.Zero }, cancellationToken: Cancel));
    }

    [Fact]
    public async Task A_program_that_does_not_exist_is_reported_not_thrown_from_deep_inside()
    {
        var error = await Assert.ThrowsAsync<ProcessStartException>(() =>
            _runner.RunAsync(new ProcessSpec { Program = "runova-no-such-program" }, cancellationToken: Cancel));

        Assert.Contains("runova-no-such-program", error.Message, StringComparison.Ordinal);
    }

    private static List<int> ProcessesInGroup(int group)
    {
        var members = new List<int>();
        foreach (var directory in Directory.EnumerateDirectories("/proc"))
        {
            if (!int.TryParse(Path.GetFileName(directory), out var pid))
            {
                continue;
            }

            try
            {
                // Fields after the command name (in parentheses): state, ppid, pgrp.
                var stat = File.ReadAllText(Path.Combine(directory, "stat"));
                var fields = stat[(stat.LastIndexOf(')') + 2)..].Split(' ');
                if (fields[0] != "Z" && int.Parse(fields[2], CultureInfo.InvariantCulture) == group)
                {
                    members.Add(pid);
                }
            }
            catch (IOException)
            {
                // The process ended while we looked.
            }
        }

        return members;
    }

    private static async Task WaitUntilAsync(Func<bool> condition)
    {
        for (var i = 0; i < 50 && !condition(); i++)
        {
            await Task.Delay(100, Cancel);
        }
    }
}
