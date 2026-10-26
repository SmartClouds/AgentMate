using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using Runova.ServerCore.Compatibility;
using Runova.ServerCore.Hosting;

namespace Runova.ServerCore.Execution;

/// <summary>Where a scheduled command's timer is: still waiting, firing now, gone, or not known.</summary>
internal enum ScheduleState
{
    Waiting,
    Running,

    /// <summary>It fired and finished, was stopped, or never existed.</summary>
    Gone,

    /// <summary>systemd could not be asked.</summary>
    Unknown,
}

/// <summary>
/// Runs privileged work (package operations, reboots) in a transient systemd unit of its own:
/// `systemd-run --collect --wait --pipe`. The unit gets systemd's normal environment for a service
/// rather than the core's hardened one, it lives in its own cgroup, and stopping it ends every
/// process in that cgroup, whatever the work started. Output comes back through the pipe.
/// </summary>
/// <remarks>
/// If the core itself stops, systemd-run (a child of the core) goes with it but the unit carries
/// on: services ignore SIGPIPE by default, so the work finishes, unwatched.
/// </remarks>
internal sealed partial class SystemdRunner(IProcessRunner runner, TimeProvider time, ILogger<SystemdRunner> logger)
{
    /// <summary>How long a stopping unit has between SIGTERM and SIGKILL (TimeoutStopSec).</summary>
    public static readonly TimeSpan StopTimeout = TimeSpan.FromSeconds(30);

    /// <summary>
    /// The core's own timer ends a run and stops the unit; systemd's limit (RuntimeMaxSec) comes
    /// this much later, for a core that is no longer there to do it.
    /// </summary>
    private static readonly TimeSpan _backstop = TimeSpan.FromMinutes(2);

    private static readonly TimeSpan _settle = TimeSpan.FromMilliseconds(500);

    private const int StopAttempts = 3;

    /// <summary>`runova-&lt;purpose&gt;-&lt;id&gt;`: nothing from a request ever reaches a unit name.</summary>
    public static string UnitName(string purpose, Guid id)
    {
        ArgumentNullException.ThrowIfNull(purpose);
        if (!Purpose().IsMatch(purpose))
        {
            throw new ArgumentException("A unit's purpose is one short lowercase word.", nameof(purpose));
        }

        return $"{CoreLayout.TransientUnitPrefix}{purpose}-{id:N}";
    }

    /// <summary>
    /// Runs the command in the unit and waits for it. Cancelling stops the unit, and so does the
    /// command's time limit (the result then says it timed out).
    /// </summary>
    public async Task<ProcessResult> RunAsync(
        string unitName,
        string description,
        ProcessSpec command,
        Action<OutputLine>? onLine,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var runtimeLimit = (long)Math.Ceiling((command.Timeout + _backstop).TotalSeconds);
        List<string> arguments =
        [
            .. UnitArguments(unitName, description),
            "--wait",
            "--pipe",
        ];
        if (command.WorkingDirectory is not null)
        {
            arguments.Add($"--working-directory={command.WorkingDirectory}");
        }

        arguments.Add($"--property=RuntimeMaxSec={runtimeLimit.ToString(CultureInfo.InvariantCulture)}");
        arguments.Add($"--property=TimeoutStopSec={((long)StopTimeout.TotalSeconds).ToString(CultureInfo.InvariantCulture)}");
        arguments.AddRange(SetEnvironment(command));
        arguments.AddRange(CommandLine(command));

        var run = new ProcessSpec
        {
            Program = "systemd-run",
            Arguments = arguments,
            Timeout = command.Timeout,
            MaxOutputBytes = command.MaxOutputBytes,
            StandardInput = command.StandardInput,
        };

        ProcessResult result;
        try
        {
            result = await runner.RunAsync(run, onLine, cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            await StopAsync(unitName);
            throw;
        }

        if (result.TimedOut)
        {
            await StopAsync(unitName);
        }

        return result;
    }

    /// <summary>
    /// Starts the command from a transient timer after <paramref name="delay"/> and returns once
    /// systemd has accepted it. The timer fires even if the core is gone by then, which is what a
    /// reboot needs: the job records its success first.
    /// </summary>
    public async Task ScheduleAsync(
        string unitName,
        string description,
        ProcessSpec command,
        TimeSpan delay,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        if (delay < TimeSpan.FromSeconds(1) || delay > TimeSpan.FromHours(1))
        {
            throw new ArgumentOutOfRangeException(nameof(delay), "A scheduled command starts one second to one hour from now.");
        }

        var seconds = (long)Math.Ceiling(delay.TotalSeconds);
        var schedule = new ProcessSpec
        {
            Program = "systemd-run",
            Arguments =
            [
                .. UnitArguments(unitName, description),
                $"--on-active={seconds.ToString(CultureInfo.InvariantCulture)}s",
                "--timer-property=AccuracySec=100ms",
                .. SetEnvironment(command),
                .. CommandLine(command),
            ],
            Timeout = TimeSpan.FromSeconds(30),
        };

        var result = await runner.RunAsync(schedule, onLine: null, cancellationToken);
        if (!result.Succeeded)
        {
            var reason = FirstLine(result.StandardError) ?? FirstLine(result.StandardOutput) ?? $"exit code {result.ExitCode}";
            throw new ProcessFailedException($"systemd would not schedule {unitName}: {reason}");
        }
    }

    /// <summary>
    /// Calls off a command scheduled with <see cref="ScheduleAsync"/> by stopping its timer. A
    /// command that has already started is left alone.
    /// </summary>
    public async Task CancelScheduledAsync(string unitName, CancellationToken cancellationToken)
    {
        CheckUnitName(unitName);
        var result = await SystemctlAsync(["stop", unitName + ".timer"], cancellationToken);
        if (!result.Succeeded)
        {
            var reason = FirstLine(result.StandardError) ?? FirstLine(result.StandardOutput) ?? $"exit code {result.ExitCode}";
            throw new ProcessFailedException($"systemd would not stop {unitName}.timer: {reason}");
        }
    }

    /// <summary>Whether a scheduled command's timer is still waiting, has fired, or is gone.</summary>
    public async Task<ScheduleState> ScheduleStateAsync(string unitName, CancellationToken cancellationToken)
    {
        CheckUnitName(unitName);
        var result = await runner.RunAsync(
            new ProcessSpec
            {
                Program = "systemctl",
                Arguments = ["show", "--property=SubState", "--value", unitName + ".timer"],
                Timeout = TimeSpan.FromSeconds(15),
            },
            onLine: null,
            cancellationToken);
        if (!result.Succeeded)
        {
            return ScheduleState.Unknown;
        }

        // An unknown unit shows as "dead"; an elapsed one has fired and its command has run.
        return result.StandardOutput.Trim() switch
        {
            "waiting" => ScheduleState.Waiting,
            "running" => ScheduleState.Running,
            _ => ScheduleState.Gone,
        };
    }

    /// <summary>
    /// Stops the unit and every process in it. systemctl stop sends SIGTERM and, after
    /// TimeoutStopSec, SIGKILL; it waits for that. A unit that is somehow still there after a few
    /// more tries (a start that raced the first stop) is killed outright.
    /// </summary>
    private async Task StopAsync(string unitName)
    {
        var service = unitName + ".service";
        // Deliberately not the caller's token: a cancelled job still has to be stopped.
        using var budget = new CancellationTokenSource(StopTimeout * 2 + TimeSpan.FromSeconds(30), time);
        try
        {
            LogStopping(logger, unitName);
            await SystemctlAsync(["stop", service], budget.Token);
            for (var attempt = 1; attempt <= StopAttempts; attempt++)
            {
                var state = await ActiveStateAsync(service, budget.Token);
                if (state is "inactive" or "failed" or "")
                {
                    return;
                }

                await Task.Delay(_settle, time, budget.Token);
                await SystemctlAsync(["stop", service], budget.Token);
            }

            LogKilling(logger, unitName);
            await SystemctlAsync(["kill", "--signal=SIGKILL", service], budget.Token);
        }
        catch (Exception error) when (error is not OutOfMemoryException)
        {
            LogStopFailed(logger, unitName, error);
        }
    }

    private async Task<string> ActiveStateAsync(string service, CancellationToken cancellationToken)
    {
        var result = await runner.RunAsync(
            new ProcessSpec
            {
                Program = "systemctl",
                Arguments = ["show", "--property=ActiveState", "--value", service],
                Timeout = TimeSpan.FromSeconds(15),
            },
            onLine: null,
            cancellationToken);
        return result.StandardOutput.Trim();
    }

    private Task<ProcessResult> SystemctlAsync(string[] arguments, CancellationToken cancellationToken) =>
        runner.RunAsync(
            new ProcessSpec { Program = "systemctl", Arguments = arguments, Timeout = StopTimeout + TimeSpan.FromSeconds(15) },
            onLine: null,
            cancellationToken);

    private static void CheckUnitName(string unitName)
    {
        if (!UnitNamePattern().IsMatch(unitName))
        {
            throw new ArgumentException($"'{unitName}' is not a unit name this core makes.", nameof(unitName));
        }
    }

    private static string[] UnitArguments(string unitName, string description)
    {
        CheckUnitName(unitName);
        return
        [
            $"--unit={unitName}",
            $"--description=Runova: {Describe(description)}",
            "--collect",
            "--quiet",
        ];
    }

    /// <summary>The command's own variables first, then the base ones it does not override.</summary>
    private static IEnumerable<string> SetEnvironment(ProcessSpec command)
    {
        foreach (var (name, value) in command.Environment)
        {
            yield return $"--setenv={name}={value}";
        }

        foreach (var (name, value) in ProcessRunner.LinuxEnvironment)
        {
            if (!command.Environment.ContainsKey(name))
            {
                yield return $"--setenv={name}={value}";
            }
        }
    }

    /// <summary>
    /// After `--`, so nothing in the command can be read as a systemd-run option. The program must
    /// be an absolute path: it is resolved on the server, not here.
    /// </summary>
    private static IEnumerable<string> CommandLine(ProcessSpec command)
    {
        if (!command.Program.StartsWith('/'))
        {
            throw new ArgumentException("A command for a unit names its program by absolute path.", nameof(command));
        }

        if (command.Arguments.Any(argument => argument.Contains('\0', StringComparison.Ordinal))
            || command.Environment.Any(entry => entry.Key.Contains('=', StringComparison.Ordinal)))
        {
            throw new ArgumentException("The command has an argument or variable a unit cannot carry.", nameof(command));
        }

        yield return "--";
        yield return command.Program;
        foreach (var argument in command.Arguments)
        {
            yield return argument;
        }
    }

    /// <summary>One printable line, as `systemctl status` shows it.</summary>
    private static string Describe(string description)
    {
        var text = new StringBuilder(description.Length);
        foreach (var character in description)
        {
            text.Append(char.IsControl(character) ? ' ' : character);
        }

        var line = text.ToString().Trim();
        return line.Length > 120 ? line[..120] : line;
    }

    private static string? FirstLine(string text) =>
        text.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).FirstOrDefault();

    [GeneratedRegex("^[a-z]{2,16}$", RegexOptions.CultureInvariant)]
    private static partial Regex Purpose();

    /// <summary>Units this core names, and the ones a core from before the rename did (a revert timer may still wait).</summary>
    [GeneratedRegex("^(?:" + CoreLayout.TransientUnitPrefix + "|" + LegacyNames.TransientUnitPrefix + ")[a-z]{2,16}-[0-9a-f]{32}$", RegexOptions.CultureInvariant)]
    private static partial Regex UnitNamePattern();

    [LoggerMessage(Level = LogLevel.Information, Message = "Stopping transient unit {Unit}.")]
    private static partial void LogStopping(ILogger logger, string unit);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Transient unit {Unit} did not stop; killing every process in it.")]
    private static partial void LogKilling(ILogger logger, string unit);

    [LoggerMessage(Level = LogLevel.Error, Message = "Could not stop transient unit {Unit}.")]
    private static partial void LogStopFailed(ILogger logger, string unit, Exception error);
}
