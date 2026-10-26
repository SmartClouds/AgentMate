using Runova.ServerCore.Cli;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Hosting;

namespace Runova.ServerCore.Firewall;

/// <summary>How long a change waits for its confirmation, and what the rollback timer runs.</summary>
internal sealed class FirewallOptions
{
    public TimeSpan ConfirmWindow { get; init; } = TimeSpan.FromSeconds(60);

    /// <summary>After the deadline, how long the core leaves the timer to report before it acts itself.</summary>
    public TimeSpan Grace { get; init; } = TimeSpan.FromSeconds(20);

    public TimeSpan MonitorInterval { get; init; } = TimeSpan.FromSeconds(5);

    /// <summary>The core's own binary, which carries the revert program (runova-core firewall-revert).</summary>
    public string RevertProgram { get; init; } = Environment.ProcessPath ?? CoreLayout.Current.BinaryPath;
}

/// <summary>
/// The rollback timer of a change set. It belongs to systemd, not to the core, so it fires even
/// if the core is killed right after a change; and the core can also run the same revert now.
/// </summary>
internal interface IFirewallTimer
{
    Task ArmAsync(Guid changeSetId, TimeSpan delay, CancellationToken cancellationToken);

    Task DisarmAsync(Guid changeSetId, CancellationToken cancellationToken);

    Task<ScheduleState> StateAsync(Guid changeSetId, CancellationToken cancellationToken);

    /// <summary>Runs the revert program now and waits for it; the change set's files hold the outcome.</summary>
    Task RevertNowAsync(Guid changeSetId, CancellationToken cancellationToken);
}

/// <summary>
/// `systemd-run --on-active=60s -- runova-core firewall-revert &lt;id&gt; --data-directory &lt;dir&gt;`:
/// a transient timer and service owned by PID 1, outside the core's cgroup.
/// </summary>
internal sealed class SystemdFirewallTimer(SystemdRunner units, FirewallOptions options, CoreDirectories directories) : IFirewallTimer
{
    public const string Purpose = "fwrevert";

    public static string UnitFor(Guid changeSetId) => SystemdRunner.UnitName(Purpose, changeSetId);

    public Task ArmAsync(Guid changeSetId, TimeSpan delay, CancellationToken cancellationToken) =>
        units.ScheduleAsync(
            UnitFor(changeSetId),
            $"Roll back firewall change {changeSetId:D} unless it is confirmed",
            Command(changeSetId),
            delay,
            cancellationToken);

    public Task DisarmAsync(Guid changeSetId, CancellationToken cancellationToken) =>
        units.CancelScheduledAsync(UnitFor(changeSetId), cancellationToken);

    public Task<ScheduleState> StateAsync(Guid changeSetId, CancellationToken cancellationToken) =>
        units.ScheduleStateAsync(UnitFor(changeSetId), cancellationToken);

    public Task RevertNowAsync(Guid changeSetId, CancellationToken cancellationToken) =>
        units.RunAsync(
            SystemdRunner.UnitName("fwrevertnow", Guid.NewGuid()),
            $"Roll back firewall change {changeSetId:D}",
            Command(changeSetId),
            onLine: null,
            cancellationToken);

    private ProcessSpec Command(Guid changeSetId) => new()
    {
        Program = options.RevertProgram,
        Arguments = [FirewallRevertCommand.Name, changeSetId.ToString("D"), "--data-directory", directories.Data],
        Timeout = TimeSpan.FromMinutes(5),
    };
}
