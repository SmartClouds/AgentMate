using Runova.ServerCore.Contracts;
using Runova.ServerCore.Firewall;
using Runova.ServerCore.Platform;

namespace Runova.ServerCore.Backups;

/// <summary>
/// The addresses and firewall a full backup records (E28). Only rules Runova can put back are
/// kept: editable, incoming ones. A firewall that cannot be read leaves the backup without one
/// rather than stopping it.
/// </summary>
internal sealed class ServerStateReader(ISystemInfoSource info, FirewallManager firewall) : IServerStateReader
{
    public async Task<string[]> AddressesAsync(CancellationToken cancellationToken) =>
        (await info.GetAsync(cancellationToken)).PublicAddresses;

    public async Task<FirewallRulesSnapshot?> FirewallAsync(CancellationToken cancellationToken)
    {
        FirewallStatus status;
        try
        {
            status = await firewall.StatusAsync(cancellationToken);
        }
        catch (Exception error) when (error is IOException or InvalidOperationException or FirewallRefusedException)
        {
            return null;
        }

        if (!status.Installed)
        {
            return null;
        }

        return new FirewallRulesSnapshot(
            status.Backend,
            status.Active,
            status.DefaultIncoming,
            [.. status.Rules
                .Where(rule => rule.Editable && !rule.Outgoing)
                .Select(rule => new FirewallRuleSpec(rule.Action, rule.Protocol, rule.Port, rule.PortTo, rule.Source, rule.Comment))]);
    }
}
