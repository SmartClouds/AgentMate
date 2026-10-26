using Runova.ServerCore.Contracts;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Platform;

namespace Runova.ServerCore.Firewall;

/// <summary>The firewall backends, made the same way by the core and by the revert program.</summary>
internal static class FirewallBackends
{
    public static IFirewallBackend? Create(FirewallBackendKind kind, IProcessRunner runner, IFirewallCommands commands, ISystemFiles files) =>
        kind switch
        {
            FirewallBackendKind.Ufw => new UfwBackend(runner, commands, files),
            FirewallBackendKind.Firewalld => new FirewalldBackend(runner, commands, files),
            _ => null,
        };
}

/// <summary>Which firewall this server has, asked again each time (installing one needs no restart).</summary>
internal interface IFirewallBackendSource
{
    IFirewallBackend Current();
}

/// <summary>
/// ufw on the Debian family and firewalld on the RHEL family, or whichever of the two is installed
/// where the family's own is not. With neither, the family's own is reported as not installed.
/// </summary>
internal sealed class InstalledFirewall(OsInfo os, IProcessRunner runner, IFirewallCommands commands, ISystemFiles files)
    : IFirewallBackendSource
{
    public IFirewallBackend Current()
    {
        var ufw = files.Exists(UfwBackend.Program);
        var firewalld = files.Exists(FirewalldBackend.Program);
        var preferred = os.Family switch
        {
            OsFamily.Debian when ufw || !firewalld => FirewallBackendKind.Ufw,
            OsFamily.Rhel when firewalld || !ufw => FirewallBackendKind.Firewalld,
            _ when ufw => FirewallBackendKind.Ufw,
            _ when firewalld => FirewallBackendKind.Firewalld,
            _ => FirewallBackendKind.None,
        };
        return FirewallBackends.Create(preferred, runner, commands, files) ?? new NoFirewall();
    }
}

/// <summary>A server where the core knows no firewall to manage.</summary>
internal sealed class NoFirewall : IFirewallBackend
{
    private const string Reason =
        "Neither ufw nor firewalld is installed on this server. Install ufw (Ubuntu, Debian) or firewalld (the RHEL family) first.";

    public FirewallBackendKind Kind => FirewallBackendKind.None;

    public Task<FirewallState> ReadAsync(CancellationToken cancellationToken) =>
        Task.FromResult(new FirewallState { Backend = FirewallBackendKind.None, Installed = false });

    public IReadOnlyList<FirewallStep> Steps(FirewallChangePlan plan) => throw new FirewallRefusedException(Reason);

    public Task ApplyAsync(FirewallChangePlan plan, IReadOnlyList<FirewallStep> steps, Action<string> log, CancellationToken cancellationToken) =>
        throw new FirewallRefusedException(Reason);

    public Task<FirewallSnapshot> SnapshotAsync(CancellationToken cancellationToken) => throw new FirewallRefusedException(Reason);

    public Task RestoreAsync(FirewallSnapshot snapshot, Action<string> log, CancellationToken cancellationToken) =>
        throw new FirewallRefusedException(Reason);
}
