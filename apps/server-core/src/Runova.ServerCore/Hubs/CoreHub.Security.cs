using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Runova.ServerCore.Audit;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Firewall;
using Runova.ServerCore.Hardening;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Hubs;

/// <summary>
/// The Security center (E15): the checklist, read by Admins, and the SSH changes it offers, made by
/// Owners after a step-up. Each fact the checklist reads is read on its own, so one the core cannot
/// read leaves its item unknown instead of failing the whole list. Every SSH change and every
/// refusal lands in the audit trail.
/// </summary>
internal sealed partial class CoreHub
{
    [Authorize(Policy = CorePolicies.Admin)]
    public async Task<SecurityChecklist> GetSecurityChecklist(SecurityChecklistRequest request)
    {
        var token = Context.ConnectionAborted;
        var available = request?.AvailableCoreVersion is { Length: > 0 and <= 64 } wanted && ReleaseVersion().IsMatch(wanted)
            ? wanted
            : null;
        var ssh = await security.Ssh.PolicyAsync(token);
        var ports = await firewall.Sshd.ReadAsync(token);
        var facts = new ChecklistFacts
        {
            Firewall = await TryReadAsync(() => firewall.Manager.StatusAsync(token)),
            Ssh = ssh,
            Updates = server.Updates.Current,
            RebootRequired = (await TryReadAsync(() => server.Info.GetAsync(token)))?.RebootRequired,
            Exposure = await TryReadAsync(() => firewall.Exposure.ReadAsync(token)),
            SshPorts = ports.Ports,
            Certificates = await TryReadAsync(() => web.Certificates.ListAsync(token)),
            Owners = await OwnersAsync(),
            CoreVersion = CoreVersion.Current,
            AvailableCoreVersion = available,
            NowUnixMs = Now,
        };
        return ChecklistRules.Build(facts, security.Ssh.Pending());
    }

    [Authorize(Policy = CorePolicies.Owner)]
    public async Task<SshHardeningPreview> PreviewSshHardening(SshHardeningRequest request)
    {
        try
        {
            return await security.Ssh.PreviewAsync(request, await SshCallerAsync(), Context.ConnectionAborted);
        }
        catch (SshHardeningRefusedException refused)
        {
            throw new HubException(refused.Message);
        }
    }

    [Authorize(Policy = CorePolicies.Owner)]
    [Authorize(Policy = CorePolicies.StepUp)]
    public async Task<SshHardeningChangeInfo> ApplySshHardening(SshHardeningRequest request)
    {
        var caller = await SshCallerAsync();
        var parameters = SshParameters(caller, new()
        {
            ["passwordLogin"] = request?.DisablePasswordLogin == true ? "off" : null,
            ["rootLogin"] = request?.RestrictRootLogin == true ? "prohibit-password" : null,
        });
        try
        {
            var change = await security.Ssh.ApplyAsync(request!, caller, Context.ConnectionAborted);
            parameters["summary"] = change.Summary;
            await AuditAsync("ssh.apply", AuditResult.Success, change.Id.ToString("D"), parameters);
            return change;
        }
        catch (SshHardeningRefusedException refused)
        {
            parameters["reason"] = refused.Message;
            await AuditAsync("ssh.apply", AuditResult.Denied, null, parameters);
            throw new HubException(refused.Message);
        }
    }

    [Authorize(Policy = CorePolicies.Owner)]
    public async Task<SshHardeningChangeInfo> ConfirmSshHardening(Guid changeId)
    {
        var caller = await SshCallerAsync();
        return await SshDecisionAsync("ssh.confirm", changeId, caller, () => security.Ssh.ConfirmAsync(changeId, caller, Context.ConnectionAborted));
    }

    [Authorize(Policy = CorePolicies.Owner)]
    public async Task<SshHardeningChangeInfo> RevertSshHardening(Guid changeId)
    {
        var caller = await SshCallerAsync();
        return await SshDecisionAsync("ssh.revert", changeId, caller, () => security.Ssh.RevertAsync(changeId, Context.ConnectionAborted));
    }

    private async Task<SshHardeningChangeInfo> SshDecisionAsync(string action, Guid changeId, SshCaller caller, Func<Task<SshHardeningChangeInfo>> decide)
    {
        var target = changeId.ToString("D");
        try
        {
            var change = await decide();
            await AuditAsync(action, AuditResult.Success, target, SshParameters(caller, new() { ["state"] = change.State.ToString() }));
            return change;
        }
        catch (SshHardeningRefusedException refused)
        {
            await AuditAsync(action, AuditResult.Denied, target, SshParameters(caller, new() { ["reason"] = refused.Message }));
            throw new HubException(refused.Message);
        }
    }

    private async Task<SshCaller> SshCallerAsync()
    {
        var ssh = await firewall.Sshd.ReadAsync(Context.ConnectionAborted);
        return new SshCaller(Caller.UserName, firewall.Connections.Identify(Context.GetHttpContext(), Context.ConnectionId, ssh.Ports));
    }

    private static Dictionary<string, string?> SshParameters(SshCaller caller, Dictionary<string, string?> parameters)
    {
        parameters["sshConnection"] = caller.Connection.Ssh is { } ssh ? ssh.Key : "unknown";
        return parameters;
    }

    private async Task<IReadOnlyList<OwnerFact>?> OwnersAsync()
    {
        try
        {
            var owners = await users.GetUsersInRoleAsync(CoreRoles.Owner);
            var facts = new List<OwnerFact>();
            foreach (var owner in owners)
            {
                facts.Add(new OwnerFact(
                    owner.UserName ?? owner.Id.ToString("D"),
                    await users.GetTwoFactorEnabledAsync(owner),
                    CoreIdentity.IsDisabled(owner),
                    owner.Id == UserId));
            }

            return facts;
        }
        catch (InvalidOperationException)
        {
            return null;
        }
    }

    /// <summary>A fact the core could not read is left unknown; the others still count.</summary>
    private static async Task<T?> TryReadAsync<T>(Func<Task<T>> read)
        where T : class
    {
        try
        {
            return await read();
        }
        catch (Exception error) when (error is IOException or InvalidOperationException or UnauthorizedAccessException or Execution.ProcessFailedException or Execution.ProcessStartException)
        {
            return null;
        }
    }

    [GeneratedRegex("^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$", RegexOptions.CultureInvariant)]
    private static partial Regex ReleaseVersion();
}
