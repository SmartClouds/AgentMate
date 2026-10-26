using Microsoft.AspNetCore.Authorization;
using Runova.ServerCore.Audit;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Hubs;

/// <summary>
/// Error reporting (E29). Admins read how it stands and send a test event. Changing it sends the
/// core's logs to a third party, so it is an Owner's call and needs a step-up. Every change lands in
/// the audit trail with the host and project, never the key.
/// </summary>
internal sealed partial class CoreHub
{
    [Authorize(Policy = CorePolicies.Admin)]
    public Task<ErrorReportingStatus> GetErrorReporting() => errorReporting.StatusAsync(Context.ConnectionAborted);

    [Authorize(Policy = CorePolicies.Owner)]
    [Authorize(Policy = CorePolicies.StepUp)]
    public async Task<ErrorReportingSaveResult> SaveErrorReporting(ErrorReportingRequest request)
    {
        var result = await errorReporting.SaveAsync(request, Caller.UserName, Context.ConnectionAborted);
        var parameters = new Dictionary<string, string?>
        {
            ["enabled"] = request?.Enabled.ToString(),
            ["environment"] = request?.Environment,
            ["level"] = request?.MinLevel,
        };
        if (result.Status is { } status)
        {
            parameters["host"] = status.Host;
            parameters["project"] = status.ProjectId;
        }
        else
        {
            parameters["reason"] = string.Join(' ', result.Problems);
        }

        await AuditAsync("errorReporting.save", result.Problems.Length == 0 ? AuditResult.Success : AuditResult.Denied, null, parameters);
        return result;
    }

    [Authorize(Policy = CorePolicies.Owner)]
    [Authorize(Policy = CorePolicies.StepUp)]
    public async Task<ErrorReportingStatus> RemoveErrorReporting()
    {
        var status = await errorReporting.RemoveAsync(Caller.UserName, Context.ConnectionAborted);
        await AuditAsync("errorReporting.remove", AuditResult.Success);
        return status;
    }

    [Authorize(Policy = CorePolicies.Admin)]
    public async Task<ErrorReportingTestResult> SendErrorReportingTest()
    {
        var status = await errorReporting.StatusAsync(Context.ConnectionAborted);
        var result = await errorReporting.SendTestAsync(Caller.UserName, Context.ConnectionAborted);
        await AuditAsync(
            "errorReporting.test",
            result.Delivered ? AuditResult.Success : AuditResult.Failed,
            null,
            new() { ["host"] = status.Host, ["project"] = status.ProjectId, ["httpStatus"] = result.HttpStatus?.ToString() });
        return result;
    }
}
