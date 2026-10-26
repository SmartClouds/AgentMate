using Microsoft.AspNetCore.Authorization;
using Runova.ServerCore.Audit;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Hubs;

/// <summary>
/// Moving the server to the Runova layout, which the app asks for once the core is new enough.
/// The core stops and comes back under its new name, so it is an Owner's call with a step-up,
/// like an update, and it shares the update's gate.
/// </summary>
internal sealed partial class CoreHub
{
    [Authorize(Policy = CorePolicies.Owner)]
    [Authorize(Policy = CorePolicies.StepUp)]
    public async Task<LayoutMigrationResult> MigrateLayout()
    {
        var result = await server.LayoutMigrator.StartAsync(Context.ConnectionAborted);
        await AuditAsync(
            "core.migrate-layout",
            result.Outcome == LayoutMigrationOutcome.Refused ? AuditResult.Denied : AuditResult.Success,
            CoreVersion.Current,
            new Dictionary<string, string?> { ["outcome"] = Jobs.JobEngine.KindName(result.Outcome), ["problem"] = result.Problem });
        return result;
    }

    [Authorize(Policy = CorePolicies.Viewer)]
    public Task<LayoutMigrationStatus> MigrationStatus() => Task.FromResult(server.LayoutMigrator.Status());
}
