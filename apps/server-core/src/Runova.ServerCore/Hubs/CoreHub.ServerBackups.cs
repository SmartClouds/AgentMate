using Hangfire;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Runova.ServerCore.Audit;
using Runova.ServerCore.Backups;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Hubs;

/// <summary>
/// Server backups (E28). Owners only. The secret key, a destination's credentials, a backup made
/// now and a stored backup deleted need a step-up. Neither the secret nor a credential reaches the
/// audit trail, a log or an answer.
/// </summary>
internal sealed partial class CoreHub
{
    [Authorize(Policy = CorePolicies.Owner)]
    public Task<BackupSecretStatus> GetBackupSecret() => backupCenter.GetSecretAsync(Context.ConnectionAborted);

    [Authorize(Policy = CorePolicies.Owner)]
    [Authorize(Policy = CorePolicies.StepUp)]
    public async Task<BackupSecretStatus> SetBackupSecret(SetBackupSecretRequest request)
    {
        var changing = !string.IsNullOrEmpty(request?.CurrentSecret);
        var status = await RefusedAsHubAsync("backup.secret.set", null, () => backupCenter.SetSecretAsync(request, Context.ConnectionAborted));
        await AuditAsync("backup.secret.set", AuditResult.Success, status.KeyId, new() { ["change"] = changing ? "true" : "false" });
        return status;
    }

    [Authorize(Policy = CorePolicies.Owner)]
    public Task<BackupDestinationInfo[]> ListBackupDestinations() => backupCenter.ListDestinationsAsync(Context.ConnectionAborted);

    [Authorize(Policy = CorePolicies.Owner)]
    [Authorize(Policy = CorePolicies.StepUp)]
    public async Task<BackupDestinationInfo> SaveBackupDestination(SaveBackupDestinationRequest request)
    {
        // A Telegram sign-in's session is sealed with the destination, then let go of; a refused
        // save keeps it, so the person can fix the form without signing in again.
        string? session = null;
        var loginId = request?.Kind == BackupDestinationKind.Telegram ? request.Secret?.TelegramLoginId : null;
        if (loginId is not null)
        {
            var signedIn = backupOperations.Telegram.PeekSession(loginId) ?? throw new HubException("The Telegram sign-in expired. Sign in again.");
            session = Convert.ToBase64String(signedIn.Session);
            request = request! with { Settings = (request.Settings ?? new BackupDestinationSettings()) with { AccountName = signedIn.AccountName, IsPremium = signedIn.IsPremium } };
        }

        var saved = await RefusedAsHubAsync(
            "backup.destination.save",
            request?.Name,
            () => backupCenter.SaveDestinationAsync(request, session, Context.ConnectionAborted));
        if (loginId is not null)
        {
            backupOperations.Telegram.TakeSession(loginId);
        }

        await AuditAsync("backup.destination.save", AuditResult.Success, saved.Id.ToString("D"), new()
        {
            ["name"] = saved.Name,
            ["kind"] = saved.Kind.ToString(),
            ["summary"] = saved.Summary,
            ["credentials"] = request?.Secret is null ? "kept" : "replaced",
        });
        return saved;
    }

    [Authorize(Policy = CorePolicies.Owner)]
    [Authorize(Policy = CorePolicies.StepUp)]
    public async Task<bool> DeleteBackupDestination(Guid destinationId)
    {
        var deleted = await backupCenter.DeleteDestinationAsync(destinationId, Context.ConnectionAborted);
        await AuditAsync("backup.destination.delete", deleted ? AuditResult.Success : AuditResult.Failed, destinationId.ToString("D"));
        return deleted;
    }

    [Authorize(Policy = CorePolicies.Owner)]
    public async Task<BackupDestinationTest> TestBackupDestination(SaveBackupDestinationRequest request)
    {
        try
        {
            return await backupOperations.Tester.TestAsync(request, Context.ConnectionAborted);
        }
        catch (Exception refused) when (refused is BackupRefusedException or Backups.Destinations.BackupDestinationException)
        {
            return new BackupDestinationTest(false, refused.Message, null);
        }
    }

    [Authorize(Policy = CorePolicies.Owner)]
    public Task<BackupPlanInfo[]> ListBackupPlans() => backupCenter.ListPlansAsync(Context.ConnectionAborted);

    [Authorize(Policy = CorePolicies.Owner)]
    public async Task<BackupPlanInfo> SaveBackupPlan(SaveBackupPlanRequest request)
    {
        var saved = await RefusedAsHubAsync("backup.plan.save", request?.Name, () => backupCenter.SavePlanAsync(request, Context.ConnectionAborted));
        await AuditAsync("backup.plan.save", AuditResult.Success, saved.Id.ToString("D"), new()
        {
            ["name"] = saved.Name,
            ["enabled"] = saved.Enabled ? "true" : "false",
            ["cron"] = saved.Cron,
            ["timeZone"] = saved.TimeZone,
            ["keepLast"] = saved.KeepLast.ToString(System.Globalization.CultureInfo.InvariantCulture),
            ["destinations"] = string.Join(',', saved.DestinationIds),
        });
        return saved;
    }

    [Authorize(Policy = CorePolicies.Owner)]
    public async Task<bool> DeleteBackupPlan(Guid planId)
    {
        var deleted = await backupCenter.DeletePlanAsync(planId, Context.ConnectionAborted);
        await AuditAsync("backup.plan.delete", deleted ? AuditResult.Success : AuditResult.Failed, planId.ToString("D"));
        return deleted;
    }

    [Authorize(Policy = CorePolicies.Owner)]
    public Task<BackupPlanPreview> PreviewBackupPlan(BackupPlanPreviewRequest request) =>
        backupCenter.PreviewAsync(request ?? throw new HubException("Describe the plan to preview."), Context.ConnectionAborted);

    [Authorize(Policy = CorePolicies.Owner)]
    public async Task<BackupRunInfo> RunBackupPlan(Guid planId)
    {
        var user = await users.FindByIdAsync(UserId.ToString("D"));
        return await RefusedAsHubAsync(
            "backup.run.start",
            planId.ToString("D"),
            () => backupOperations.Runner.StartAsync(planId, [], false, UserId, user?.UserName, Context.ConnectionAborted));
    }

    [Authorize(Policy = CorePolicies.Owner)]
    [Authorize(Policy = CorePolicies.StepUp)]
    public async Task<BackupRunInfo> RunBackupNow(RunBackupNowRequest request)
    {
        var user = await users.FindByIdAsync(UserId.ToString("D"));
        return await RefusedAsHubAsync(
            "backup.run.start",
            null,
            () => backupOperations.Runner.StartAsync(null, request?.DestinationIds ?? [], request?.KeepForDownload == true, UserId, user?.UserName, Context.ConnectionAborted));
    }

    [Authorize(Policy = CorePolicies.Owner)]
    public Task<BackupRunInfo[]> ListBackupRuns(int limit) => backupCenter.ListRunsAsync(limit, Context.ConnectionAborted);

    [Authorize(Policy = CorePolicies.Owner)]
    public Task<BackupRunInfo?> GetBackupRun(Guid runId) => backupCenter.FindRunAsync(runId, Context.ConnectionAborted);

    [Authorize(Policy = CorePolicies.Owner)]
    public async Task<StoredBackupInfo[]> ListStoredBackups(Guid destinationId)
    {
        try
        {
            return await backupOperations.Stored.ListAsync(destinationId, Context.ConnectionAborted);
        }
        catch (Exception refused) when (refused is BackupRefusedException or Backups.Destinations.BackupDestinationException)
        {
            throw new HubException(refused.Message);
        }
    }

    [Authorize(Policy = CorePolicies.Owner)]
    [Authorize(Policy = CorePolicies.StepUp)]
    public async Task<bool> DeleteStoredBackup(Guid destinationId, Guid backupId)
    {
        try
        {
            var deleted = await backupOperations.Stored.DeleteAsync(destinationId, backupId, Context.ConnectionAborted);
            await AuditAsync("backup.stored.delete", deleted ? AuditResult.Success : AuditResult.Failed, backupId.ToString("D"), new() { ["destination"] = destinationId.ToString("D") });
            return deleted;
        }
        catch (Exception refused) when (refused is BackupRefusedException or Backups.Destinations.BackupDestinationException)
        {
            await AuditAsync("backup.stored.delete", AuditResult.Failed, backupId.ToString("D"), new() { ["reason"] = refused.Message });
            throw new HubException(refused.Message);
        }
    }

    [Authorize(Policy = CorePolicies.Owner)]
    [Authorize(Policy = CorePolicies.StepUp)]
    public Task<TelegramLoginState> StartTelegramLogin(StartTelegramLoginRequest request) =>
        backupOperations.Telegram.StartAsync(request, Context.ConnectionAborted);

    [Authorize(Policy = CorePolicies.Owner)]
    [Authorize(Policy = CorePolicies.StepUp)]
    public async Task<TelegramLoginState> ContinueTelegramLogin(ContinueTelegramLoginRequest request)
    {
        var state = await backupOperations.Telegram.ContinueAsync(request, Context.ConnectionAborted);
        if (state.Step == TelegramLoginStep.Done && state.Problem is null)
        {
            await AuditAsync("backup.telegram.signin", AuditResult.Success, state.AccountName);
        }

        return state;
    }

    [Authorize(Policy = CorePolicies.Owner)]
    [Authorize(Policy = CorePolicies.StepUp)]
    public async Task<BackupFetchInfo> FetchStoredBackup(Guid destinationId, Guid backupId)
    {
        var fetch = backupOperations.Fetcher.Begin(backupId);
        backupOperations.Jobs.Create<BackupFetcher>(
            fetcher => fetcher.RunAsync(fetch.Id, destinationId, backupId, CancellationToken.None),
            new Hangfire.States.EnqueuedState(BackupRegistration.Queue));
        await AuditAsync("backup.fetch", AuditResult.Success, backupId.ToString("D"), new() { ["destination"] = destinationId.ToString("D") });
        return fetch;
    }

    [Authorize(Policy = CorePolicies.Owner)]
    public Task<BackupFetchInfo?> GetBackupFetch(Guid fetchId) => Task.FromResult(backupOperations.Fetcher.Find(fetchId));

    [Authorize(Policy = CorePolicies.Owner)]
    public async Task<PendingServerRestore?> GetPendingServerRestore()
    {
        try
        {
            return await backupOperations.Restorer.PendingAsync(Context.ConnectionAborted);
        }
        catch (BackupRefusedException refused)
        {
            throw new HubException(refused.Message);
        }
    }

    [Authorize(Policy = CorePolicies.Owner)]
    [Authorize(Policy = CorePolicies.StepUp)]
    public async Task<ServerRestoreStatus> RunServerRestore(RunServerRestoreRequest request)
    {
        if (backupOperations.Restorer.Status is { State: BackupRunState.Running } running)
        {
            return running;
        }

        var moveAddresses = request?.MoveAddresses == true;
        var queued = backupOperations.Restorer.Queue();
        backupOperations.Jobs.Create<ServerRestorer>(
            restorer => restorer.RunAsync(moveAddresses, CancellationToken.None),
            new Hangfire.States.EnqueuedState(BackupRegistration.Queue));
        await AuditAsync("backup.restore.server.start", AuditResult.Success, null, new() { ["moveAddresses"] = moveAddresses ? "true" : "false" });
        return queued;
    }

    [Authorize(Policy = CorePolicies.Owner)]
    public Task<ServerRestoreStatus?> GetServerRestoreStatus() => Task.FromResult(backupOperations.Restorer.Status);

    /// <summary>Runs work whose refusals are worded for the person: each is audited as failed and sent back as it is.</summary>
    private async Task<T> RefusedAsHubAsync<T>(string action, string? target, Func<Task<T>> work)
    {
        try
        {
            return await work();
        }
        catch (BackupRefusedException refused)
        {
            await AuditAsync(action, AuditResult.Failed, target, new() { ["reason"] = refused.Message });
            throw new HubException(refused.Message);
        }
    }
}
