using System.Globalization;
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Runova.ServerCore.Audit;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Jobs;
using Runova.ServerCore.Security;
using Runova.ServerCore.Updates;

namespace Runova.ServerCore.Hubs;

/// <summary>
/// Changing the server. Operators run updates, restarts and reboots (upgrading everything and
/// rebooting need a step-up: both can take every service down); switching automatic updates is
/// for Admins. Each call starts a job and returns it; every call lands in the audit trail, refused
/// ones included.
/// </summary>
internal sealed partial class CoreHub
{
    private Requester Caller => new(UserId, User.FindFirstValue(ClaimTypes.Name) ?? string.Empty);

    [Authorize(Policy = CorePolicies.Operator)]
    public Task<JobInfo> CheckForUpdates() =>
        StartJobAsync("packages.check", () => server.SystemJobs.CheckForUpdatesAsync(Caller, Context.ConnectionAborted));

    [Authorize(Policy = CorePolicies.Operator)]
    public Task<JobInfo> UpgradeSecurityPackages() =>
        StartJobAsync("packages.upgrade-security", () => server.SystemJobs.UpgradeAsync(securityOnly: true, Caller, Context.ConnectionAborted));

    [Authorize(Policy = CorePolicies.Operator)]
    [Authorize(Policy = CorePolicies.StepUp)]
    public Task<JobInfo> UpgradeAllPackages() =>
        StartJobAsync("packages.upgrade", () => server.SystemJobs.UpgradeAsync(securityOnly: false, Caller, Context.ConnectionAborted));

    [Authorize(Policy = CorePolicies.Operator)]
    [Authorize(Policy = CorePolicies.StepUp)]
    public Task<JobInfo> RebootServer() =>
        StartJobAsync("system.reboot", () => server.SystemJobs.RebootAsync(Caller, Context.ConnectionAborted));

    [Authorize(Policy = CorePolicies.Operator)]
    public async Task<JobInfo> RestartService(ManagedService service)
    {
        if (!Enum.IsDefined(service))
        {
            await AuditAsync("service.restart", AuditResult.Denied, null, new() { ["service"] = ((int)service).ToString(CultureInfo.InvariantCulture) });
            throw new HubException("Only Docker and nginx can be restarted from the app.");
        }

        return await StartJobAsync(
            "service.restart",
            () => server.SystemJobs.RestartAsync(service, Caller, Context.ConnectionAborted),
            new() { ["service"] = JobEngine.KindName(service) });
    }

    [Authorize(Policy = CorePolicies.Operator)]
    public async Task CancelJob(Guid jobId)
    {
        var job = await server.Jobs.GetAsync(jobId, Context.ConnectionAborted) ?? throw new HubException("There is no such job.");
        var target = jobId.ToString("D");
        if (!server.Jobs.Cancel(jobId))
        {
            await AuditAsync("job.cancel", AuditResult.Failed, target);
            throw new HubException(job.State == JobState.Running
                ? "This job cannot be stopped once it has started."
                : "This job has already finished.");
        }

        await AuditAsync("job.cancel", AuditResult.Success, target);
    }

    [Authorize(Policy = CorePolicies.Operator)]
    public async Task<AlertInfo> AcknowledgeAlert(long alertId)
    {
        var alert = await server.Alerts.AcknowledgeAsync(alertId, UserId, Caller.UserName, Context.ConnectionAborted)
            ?? throw new HubException("There is no such alert.");
        await AuditAsync("alert.acknowledge", AuditResult.Success, alertId.ToString(CultureInfo.InvariantCulture));
        return alert;
    }

    [Authorize(Policy = CorePolicies.Admin)]
    public Task<JobInfo> SetAutomaticSecurityUpdates(bool enabled) =>
        StartJobAsync(
            "packages.automatic-updates",
            () => server.SystemJobs.SetAutomaticUpdatesAsync(enabled, Caller, Context.ConnectionAborted),
            new() { ["enabled"] = enabled ? "true" : "false" });

    /// <summary>Starts the job and records it; a job already busy with the same thing is refused and recorded too.</summary>
    private async Task<JobInfo> StartJobAsync(string action, Func<Task<JobInfo>> start, Dictionary<string, string?>? parameters = null)
    {
        try
        {
            var job = await start();
            await AuditAsync(action, AuditResult.Success, job.Id.ToString("D"), parameters);
            return job;
        }
        catch (JobConflictException conflict)
        {
            await AuditAsync(
                action,
                AuditResult.Failed,
                null,
                new Dictionary<string, string?>(parameters ?? []) { ["busyWith"] = conflict.Holder.Id.ToString("D") });
            throw new HubException(conflict.Message);
        }
    }
}
