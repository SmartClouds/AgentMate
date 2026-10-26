using Runova.ServerCore.Cli;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Hosting;

namespace Runova.ServerCore.Hardening;

/// <summary>How long an SSH change waits for its confirmation, and what its rollback timer runs.</summary>
internal sealed class SshHardeningOptions
{
    public TimeSpan ConfirmWindow { get; init; } = TimeSpan.FromSeconds(60);

    /// <summary>After the deadline, how long the core leaves the timer to act before it reverts itself.</summary>
    public TimeSpan Grace { get; init; } = TimeSpan.FromSeconds(20);

    public TimeSpan MonitorInterval { get; init; } = TimeSpan.FromSeconds(5);

    /// <summary>The core's own binary, which carries the revert program (runova-core ssh-revert).</summary>
    public string RevertProgram { get; init; } = Environment.ProcessPath ?? CoreLayout.Current.BinaryPath;
}

/// <summary>The rollback timer of an SSH change, owned by systemd so it fires with the core gone.</summary>
internal interface ISshHardeningTimer
{
    Task ArmAsync(Guid changeId, TimeSpan delay, CancellationToken cancellationToken);

    Task DisarmAsync(Guid changeId, CancellationToken cancellationToken);
}

/// <summary>`systemd-run --on-active=60s -- runova-core ssh-revert &lt;id&gt; --data-directory &lt;dir&gt;`.</summary>
internal sealed class SystemdSshHardeningTimer(SystemdRunner units, SshHardeningOptions options, CoreDirectories directories) : ISshHardeningTimer
{
    public const string Purpose = "sshrevert";

    public Task ArmAsync(Guid changeId, TimeSpan delay, CancellationToken cancellationToken) =>
        units.ScheduleAsync(
            SystemdRunner.UnitName(Purpose, changeId),
            $"Roll back SSH change {changeId:D} unless it is confirmed",
            new ProcessSpec
            {
                Program = options.RevertProgram,
                Arguments = [SshRevertCommand.Name, changeId.ToString("D"), "--data-directory", directories.Data],
                Timeout = TimeSpan.FromMinutes(2),
            },
            delay,
            cancellationToken);

    public Task DisarmAsync(Guid changeId, CancellationToken cancellationToken) =>
        units.CancelScheduledAsync(SystemdRunner.UnitName(Purpose, changeId), cancellationToken);
}
