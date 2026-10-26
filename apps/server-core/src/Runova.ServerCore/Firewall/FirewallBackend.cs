using System.Text.Json.Serialization;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Execution;

namespace Runova.ServerCore.Firewall;

/// <summary>One step of a change: a command, or a file the core writes itself.</summary>
internal sealed record FirewallStep(string Display, ProcessSpec? Command = null, FirewallFileWrite? Write = null);

internal sealed record FirewallFileWrite(string Path, string Content, UnixFileMode Mode);

/// <summary>A file as it was before a change. Content null: it did not exist.</summary>
internal sealed record SnapshotFile(string Path, string? Content, UnixFileMode Mode);

/// <summary>
/// What putting the firewall back needs: its configuration files as they were and, for
/// firewalld, whether its service ran and started at boot. Stored as JSON beside the change set,
/// so the revert program can restore it with no database and no core running.
/// </summary>
internal sealed record FirewallSnapshot(
    FirewallBackendKind Backend,
    IReadOnlyList<SnapshotFile> Files,
    long TakenAtUnixMs,
    bool? ServiceActive = null,
    bool? ServiceEnabled = null,
    string? Zone = null);

/// <summary>
/// The commands that change the firewall go through here: a transient systemd unit in the core
/// (its hardened service must not be where netfilter work runs), the program itself in the
/// revert program, which already runs in a unit of its own.
/// </summary>
internal interface IFirewallCommands
{
    Task<ProcessResult> RunAsync(ProcessSpec command, string description, CancellationToken cancellationToken);
}

internal sealed class TransientUnitCommands(SystemdRunner units) : IFirewallCommands
{
    public Task<ProcessResult> RunAsync(ProcessSpec command, string description, CancellationToken cancellationToken) =>
        units.RunAsync(SystemdRunner.UnitName("firewall", Guid.NewGuid()), description, command, onLine: null, cancellationToken);
}

internal sealed class DirectCommands(IProcessRunner runner) : IFirewallCommands
{
    public Task<ProcessResult> RunAsync(ProcessSpec command, string description, CancellationToken cancellationToken) =>
        runner.RunAsync(command, onLine: null, cancellationToken);
}

/// <summary>ufw or firewalld: reading the rules, turning a plan into commands, and saving and restoring.</summary>
internal interface IFirewallBackend
{
    FirewallBackendKind Kind { get; }

    Task<FirewallState> ReadAsync(CancellationToken cancellationToken);

    /// <summary>The exact steps that turn the plan's current firewall into its result. Changes nothing.</summary>
    IReadOnlyList<FirewallStep> Steps(FirewallChangePlan plan);

    /// <summary>Runs the steps in order and stops at the first that fails (FirewallStepFailedException).</summary>
    Task ApplyAsync(FirewallChangePlan plan, IReadOnlyList<FirewallStep> steps, Action<string> log, CancellationToken cancellationToken);

    Task<FirewallSnapshot> SnapshotAsync(CancellationToken cancellationToken);

    Task RestoreAsync(FirewallSnapshot snapshot, Action<string> log, CancellationToken cancellationToken);
}

/// <summary>A step of a change failed; the message says which and what the program printed.</summary>
internal sealed class FirewallStepFailedException(string message) : Exception(message);

/// <summary>Snapshots on disk, in the core's JSON shape (enums by name).</summary>
[JsonSerializable(typeof(FirewallSnapshot))]
[JsonSourceGenerationOptions(UseStringEnumConverter = true, WriteIndented = true)]
internal sealed partial class FirewallSnapshotJson : JsonSerializerContext;

/// <summary>Running steps the same way for every real backend.</summary>
internal static class FirewallSteps
{
    public static async Task RunAsync(
        IReadOnlyList<FirewallStep> steps,
        IFirewallCommands commands,
        Platform.ISystemFiles files,
        Action<string> log,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(steps);
        ArgumentNullException.ThrowIfNull(commands);
        ArgumentNullException.ThrowIfNull(files);
        ArgumentNullException.ThrowIfNull(log);
        foreach (var step in steps)
        {
            log(step.Display);
            if (step.Write is { } write)
            {
                files.WriteText(write.Path, write.Content, write.Mode);
                continue;
            }

            if (step.Command is not { } command)
            {
                continue;
            }

            var result = await commands.RunAsync(command, step.Display, cancellationToken);
            foreach (var line in Lines(result.StandardOutput).Concat(Lines(result.StandardError)))
            {
                log(line);
            }

            if (!result.Succeeded)
            {
                var said = Lines(result.StandardError).Concat(Lines(result.StandardOutput)).FirstOrDefault();
                throw new FirewallStepFailedException(result.TimedOut
                    ? $"\"{step.Display}\" did not finish in time and was stopped."
                    : $"\"{step.Display}\" failed (exit code {result.ExitCode}){(said is null ? "." : $": {said}")}");
            }
        }
    }

    public static IEnumerable<string> Lines(string text) =>
        text.Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(line => line.TrimEnd('\r')).Where(line => line.Length > 0);
}
