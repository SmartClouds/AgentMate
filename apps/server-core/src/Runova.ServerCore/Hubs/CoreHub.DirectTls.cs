using System.Globalization;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Runova.ServerCore.Audit;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.DirectTls;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Hubs;

/// <summary>
/// Direct TLS (E16). Every role reads how it stands, the pin included (the app only trusts a pin it
/// read over SSH). Owners turn it on, with a step-up since it opens a port to the network, and off.
/// The firewall rule for the port is a change set of its own, made by the app through the Firewall
/// methods so it gets the same guard and safe apply.
/// </summary>
internal sealed partial class CoreHub
{
    [Authorize(Policy = CorePolicies.Viewer)]
    public Task<DirectTlsStatus> GetDirectTls() => directTls.StatusAsync(Context.ConnectionAborted);

    [Authorize(Policy = CorePolicies.Owner)]
    [Authorize(Policy = CorePolicies.StepUp)]
    public async Task<DirectTlsStatus> EnableDirectTls(DirectTlsRequest request)
    {
        var parameters = new Dictionary<string, string?>
        {
            ["port"] = request?.Port.ToString(CultureInfo.InvariantCulture),
            ["sources"] = request?.Sources is { Length: > 0 } sources ? string.Join(' ', sources.Take(DirectTlsSettings.MaxSources)) : "any",
        };
        try
        {
            var ssh = await firewall.Sshd.ReadAsync(Context.ConnectionAborted);
            var status = await directTls.EnableAsync(request ?? new DirectTlsRequest(0), Caller.UserName, ssh.Ports, Context.ConnectionAborted);
            parameters["listening"] = status.Listening ? "true" : "false";
            await AuditAsync("directTls.enable", AuditResult.Success, null, parameters);
            return status;
        }
        catch (DirectTlsRefusedException refused)
        {
            parameters["reason"] = refused.Message;
            await AuditAsync("directTls.enable", AuditResult.Denied, null, parameters);
            throw new HubException(refused.Message);
        }
    }

    [Authorize(Policy = CorePolicies.Owner)]
    public async Task<DirectTlsStatus> DisableDirectTls()
    {
        var status = await directTls.DisableAsync(Caller.UserName, Context.ConnectionAborted);
        await AuditAsync("directTls.disable", AuditResult.Success, null, new() { ["port"] = status.Port.ToString(CultureInfo.InvariantCulture) });
        return status;
    }
}
