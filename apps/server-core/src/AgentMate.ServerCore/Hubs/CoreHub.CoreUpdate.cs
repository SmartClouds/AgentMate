using AgentMate.ServerCore.Audit;
using AgentMate.ServerCore.Contracts;
using AgentMate.ServerCore.Jobs;
using AgentMate.ServerCore.Security;
using AgentMate.ServerCore.Updates;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;

namespace AgentMate.ServerCore.Hubs;

/// <summary>
/// The core updating itself from a GitHub release, without SSH. Whatever it switches to runs as
/// root, so it is an Owner's call with a step-up, and every attempt lands in the audit trail. The
/// upload the app falls back on is a REST route (Endpoints/CoreUpdateEndpoints.cs).
/// </summary>
internal sealed partial class CoreHub
{
    [Authorize(Policy = CorePolicies.Owner)]
    [Authorize(Policy = CorePolicies.StepUp)]
    public async Task<CoreUpdateResult> UpdateCore(CoreUpdateRequest request)
    {
        var parameters = new Dictionary<string, string?>
        {
            ["version"] = request?.Version,
            ["sha256"] = request?.Sha256,
            ["via"] = "download",
        };
        try
        {
            var result = await server.CoreUpdater.DownloadAsync(request!, Context.ConnectionAborted);
            parameters["outcome"] = JobEngine.KindName(result.Outcome);
            parameters["problem"] = result.Problem;
            await AuditAsync("core.update", result.Outcome == CoreUpdateOutcome.Switching ? AuditResult.Success : AuditResult.Failed, CoreVersion.Current, parameters);
            return result;
        }
        catch (CoreUpdateException error)
        {
            parameters["error"] = error.Code;
            await AuditAsync("core.update", error.Error is CoreUpdateError.Invalid or CoreUpdateError.Busy ? AuditResult.Denied : AuditResult.Failed, CoreVersion.Current, parameters);
            throw new HubException(error.Message);
        }
    }
}
