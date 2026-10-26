using System.Globalization;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Runova.ServerCore.Audit;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Firewall;
using Runova.ServerCore.Jobs;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Hubs;

/// <summary>
/// The host firewall (E13). Every role reads it; Admins change it. A change set decides for itself
/// whether it also needs a step-up (turning the firewall on or off, or overriding the SSH lockout
/// guard; see FirewallChangePlan and FirewallManager), which the attributes alone cannot express,
/// so the session's step-up is read here and handed to the manager. Every change and every
/// refusal lands in the audit trail.
/// </summary>
internal sealed partial class CoreHub
{
    [Authorize(Policy = CorePolicies.Viewer)]
    public Task<FirewallStatus> GetFirewallStatus() => firewall.Manager.StatusAsync(Context.ConnectionAborted);

    [Authorize(Policy = CorePolicies.Viewer)]
    public Task<FirewallPreset[]> GetFirewallPresets() => firewall.Manager.PresetsAsync(Context.ConnectionAborted);

    [Authorize(Policy = CorePolicies.Viewer)]
    public Task<FirewallChangeSetInfo[]> ListFirewallChangeSets(FirewallChangeSetQuery query) =>
        firewall.Manager.ListAsync(query, Context.ConnectionAborted);

    [Authorize(Policy = CorePolicies.Viewer)]
    public Task<ExposureInventory> GetExposure() => firewall.Exposure.ReadAsync(Context.ConnectionAborted);

    [Authorize(Policy = CorePolicies.Admin)]
    public async Task<FirewallChangePreview> PreviewFirewallChanges(FirewallChangeRequest request)
    {
        try
        {
            return await firewall.Manager.PreviewAsync(request, await FirewallCallerAsync(), Context.ConnectionAborted);
        }
        catch (FirewallRefusedException refused)
        {
            throw new HubException(refused.Message);
        }
    }

    [Authorize(Policy = CorePolicies.Admin)]
    public async Task<FirewallChangeSetInfo> ApplyFirewallChanges(FirewallChangeRequest request)
    {
        var caller = await FirewallCallerAsync();
        try
        {
            var change = await firewall.Manager.ApplyAsync(request, caller, Context.ConnectionAborted);
            await AuditAsync(
                "firewall.apply",
                AuditResult.Success,
                change.Id.ToString("D"),
                FirewallParameters(caller, new()
                {
                    ["summary"] = change.Summary,
                    ["backend"] = JobEngine.KindName(change.Backend),
                    ["guardOverridden"] = change.GuardOverridden ? "true" : "false",
                }));
            return change;
        }
        catch (FirewallRefusedException refused)
        {
            await AuditAsync(
                "firewall.apply",
                refused.Verdict is not null || refused.NeedsStepUp ? AuditResult.Denied : AuditResult.Failed,
                null,
                FirewallParameters(caller, new() { ["reason"] = refused.Message }));
            throw new HubException(refused.Message);
        }
    }

    [Authorize(Policy = CorePolicies.Admin)]
    public Task<FirewallChangeSetInfo> ConfirmFirewallChanges(Guid changeSetId) =>
        DecideAsync("firewall.confirm", changeSetId, (caller, token) => firewall.Manager.ConfirmAsync(changeSetId, caller, token));

    [Authorize(Policy = CorePolicies.Admin)]
    public Task<FirewallChangeSetInfo> RevertFirewallChanges(Guid changeSetId) =>
        DecideAsync("firewall.revert", changeSetId, (caller, token) => firewall.Manager.RevertAsync(changeSetId, caller, token));

    private async Task<FirewallChangeSetInfo> DecideAsync(
        string action,
        Guid changeSetId,
        Func<FirewallCaller, CancellationToken, Task<FirewallChangeSetInfo>> decide)
    {
        var caller = await FirewallCallerAsync();
        var target = changeSetId.ToString("D");
        try
        {
            var change = await decide(caller, Context.ConnectionAborted);
            await AuditAsync(action, AuditResult.Success, target, FirewallParameters(caller, new() { ["state"] = JobEngine.KindName(change.State) }));
            return change;
        }
        catch (FirewallRefusedException refused)
        {
            await AuditAsync(action, AuditResult.Denied, target, FirewallParameters(caller, new() { ["reason"] = refused.Message }));
            throw new HubException(refused.Message);
        }
    }

    /// <summary>Who asks, over which connection (the SSH one when the core can tell), and whether they stepped up.</summary>
    private async Task<FirewallCaller> FirewallCallerAsync()
    {
        var ssh = await firewall.Sshd.ReadAsync(Context.ConnectionAborted);
        var connection = firewall.Connections.Identify(Context.GetHttpContext(), Context.ConnectionId, ssh.Ports);
        var stepUpUntil = await db.DeviceSessions
            .Where(session => session.Id == SessionId)
            .Select(session => session.StepUpUntil)
            .FirstOrDefaultAsync(Context.ConnectionAborted);
        return new FirewallCaller(UserId, Caller.UserName, DeviceId, connection, stepUpUntil is long until && until > Now);
    }

    private static Dictionary<string, string?> FirewallParameters(FirewallCaller caller, Dictionary<string, string?> parameters)
    {
        parameters["sshConnection"] = caller.Connection.Ssh is { } ssh
            ? $"{ssh.Client} {ssh.ClientPort.ToString(CultureInfo.InvariantCulture)} {ssh.Server} {ssh.ServerPort.ToString(CultureInfo.InvariantCulture)}"
            : "unknown";
        return parameters;
    }
}
