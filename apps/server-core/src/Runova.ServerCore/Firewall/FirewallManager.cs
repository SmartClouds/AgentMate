using System.Globalization;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Runova.ServerCore.Alerts;
using Runova.ServerCore.Audit;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Hosting;

namespace Runova.ServerCore.Firewall;

/// <summary>Who is asking, over which connection, and whether they stepped up in the last ten minutes.</summary>
internal sealed record FirewallCaller(Guid UserId, string UserName, Guid DeviceId, CallerConnection Connection, bool SteppedUp);

/// <summary>
/// Changes the host firewall safely. A change set is checked (the planner), judged by the lockout
/// guard, then applied in this order: the current rules are saved to the change set's folder, a
/// systemd timer that puts them back after the confirm window is armed, and only then does the
/// change run; the firewall is read back to see it took. Confirming must come over a new SSH
/// connection and disarms the timer. If nobody confirms, the timer restores the saved rules even
/// with the core killed; the core notices afterwards, records it and raises an alert. One change
/// waits for confirmation at a time.
/// </summary>
internal sealed partial class FirewallManager(
    IFirewallBackendSource backends,
    ISshdSettings sshd,
    IFirewallTimer timer,
    IDbContextFactory<CoreDbContext> contexts,
    AlertCenter alerts,
    AuditLog audit,
    CoreDirectories directories,
    FirewallOptions options,
    TimeProvider time,
    ILogger<FirewallManager> logger) : BackgroundService
{
    public const string AlertResource = "firewall";

    private const int MaxListed = 100;
    private const int MaxErrorLength = 1000;
    private const int MaxSummaryLength = 2000;

    private readonly SemaphoreSlim _gate = new(1, 1);

    private long Now => time.GetUtcNow().ToUnixTimeMilliseconds();

    private int WindowSeconds => (int)Math.Round(options.ConfirmWindow.TotalSeconds);

    public override void Dispose()
    {
        _gate.Dispose();
        base.Dispose();
    }

    public async Task<FirewallStatus> StatusAsync(CancellationToken cancellationToken)
    {
        var backend = backends.Current();
        FirewallState state;
        string? error = null;
        try
        {
            state = await backend.ReadAsync(cancellationToken);
        }
        catch (Exception failure) when (IsMachineFailure(failure))
        {
            state = new FirewallState { Backend = backend.Kind, Installed = backend.Kind != FirewallBackendKind.None };
            error = $"The core could not read the firewall: {failure.Message}";
        }

        var ssh = await sshd.ReadAsync(cancellationToken);
        var pending = await PendingAsync(cancellationToken);
        return new FirewallStatus(
            state.Backend,
            state.Installed,
            state.Active,
            state.DefaultIncoming,
            state.DefaultOutgoing,
            state.Ipv6,
            [.. state.Rules.Select(FirewallEvaluation.ToInfo)],
            [.. state.Warnings],
            ssh,
            WindowSeconds,
            Now,
            state.Zone,
            pending is null ? null : ToInfo(pending),
            error);
    }

    public async Task<FirewallPreset[]> PresetsAsync(CancellationToken cancellationToken) =>
        FirewallPresets.For((await sshd.ReadAsync(cancellationToken)).Ports);

    public async Task<FirewallChangeSetInfo[]> ListAsync(FirewallChangeSetQuery? query, CancellationToken cancellationToken)
    {
        var limit = Math.Clamp(query?.Limit ?? 20, 1, MaxListed);
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var rows = await db.FirewallChangeSets.AsNoTracking()
            .OrderByDescending(change => change.CreatedAt)
            .Take(limit)
            .ToListAsync(cancellationToken);
        return [.. rows.Select(ToInfo)];
    }

    public async Task<FirewallChangePreview> PreviewAsync(FirewallChangeRequest request, FirewallCaller caller, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(caller);
        var prepared = await PrepareAsync(request, caller, cancellationToken);
        return new FirewallChangePreview(
            prepared.Plan.Summary,
            [.. prepared.Steps.Select(step => step.Display)],
            [.. prepared.Plan.Notes],
            [.. prepared.Plan.Result.Rules.Select(FirewallEvaluation.ToInfo)],
            prepared.Plan.Result.Active,
            prepared.Plan.Result.DefaultIncoming,
            prepared.Verdict,
            prepared.Plan.NeedsStepUp || prepared.Verdict.Blocked,
            WindowSeconds);
    }

    public async Task<FirewallChangeSetInfo> ApplyAsync(FirewallChangeRequest request, FirewallCaller caller, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(caller);
        await _gate.WaitAsync(cancellationToken);
        try
        {
            if (await PendingAsync(cancellationToken) is { } pending)
            {
                throw new FirewallRefusedException(
                    $"Another firewall change is waiting for its confirmation (\"{pending.Summary}\"). Confirm or revert it first.");
            }

            var prepared = await PrepareAsync(request, caller, cancellationToken);
            var verdict = prepared.Verdict;
            var overridden = false;
            if (verdict.Blocked)
            {
                if (string.IsNullOrWhiteSpace(request.OverrideConfirmation))
                {
                    throw new FirewallRefusedException(
                        $"This change would cut this computer off from SSH. {string.Join(" ", verdict.Reasons)} "
                        + $"To apply it anyway, type \"{verdict.ConfirmationPhrase}\".",
                        verdict);
                }

                if (!LockoutGuard.Confirms(verdict, request.OverrideConfirmation))
                {
                    throw new FirewallRefusedException(
                        $"That is not the phrase. To apply this change anyway, type \"{verdict.ConfirmationPhrase}\".",
                        verdict);
                }

                if (!caller.SteppedUp)
                {
                    throw new FirewallRefusedException(
                        "Applying a change the SSH check refused needs your password again (a step-up).",
                        verdict,
                        needsStepUp: true);
                }

                overridden = true;
            }

            if (prepared.Plan.NeedsStepUp && !caller.SteppedUp)
            {
                throw new FirewallRefusedException(
                    $"Turning the firewall {(prepared.Plan.Enable == true ? "on" : "off")} needs your password again (a step-up).",
                    needsStepUp: true);
            }

            if (prepared.Steps.Count == 0)
            {
                throw new FirewallRefusedException(
                    prepared.Plan.Notes.Count > 0 ? $"Nothing would change: {string.Join(" ", prepared.Plan.Notes)}" : "Nothing would change.");
            }

            return await SafeApplyAsync(prepared, request, caller, overridden);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<FirewallChangeSetInfo> ConfirmAsync(Guid changeSetId, FirewallCaller caller, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(caller);
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var row = await FindAsync(changeSetId, cancellationToken);
            if (row.State == FirewallChangeState.Confirmed)
            {
                return ToInfo(row);
            }

            if (row.State != FirewallChangeState.AwaitingConfirmation)
            {
                throw new FirewallRefusedException($"This change {StateWords(row)}, so there is nothing to confirm.");
            }

            if (row.RequestedBy != caller.UserId)
            {
                throw new FirewallRefusedException("Only the person who made this change can confirm it.");
            }

            if (row.DeviceId != caller.DeviceId)
            {
                throw new FirewallRefusedException(
                    "Confirm from the computer that made this change: a new SSH connection from it is what shows it still gets in.");
            }

            if (caller.Connection.Key == row.AppliedOver)
            {
                throw new FirewallRefusedException(
                    "This confirmation came over the same SSH connection that made the change, and a firewall change never cuts a "
                    + "connection that is already open. Confirm over a new SSH connection: that shows a new one still gets in.");
            }

            if (row.AppliedOverSsh && caller.Connection.Ssh is null)
            {
                throw new FirewallRefusedException(
                    "The core could not tell which SSH connection this confirmation came over, so it cannot be sure a new connection "
                    + "gets in. The change rolls back by itself at the deadline; confirm over a new SSH connection before then.");
            }

            var files = Files(row.Id);
            if (files.Decide(FirewallDecision.Confirmed) == FirewallDecision.Reverted)
            {
                await SettleRevertedAsync(row, files, FirewallRollbackCause.Timer, cancellationToken);
                throw new FirewallRefusedException(
                    "Too late: the rollback timer put the old rules back before this confirmation arrived. "
                    + $"Make the change again and confirm it within {WindowSeconds.ToString(CultureInfo.InvariantCulture)} seconds.");
            }

            await DisarmQuietlyAsync(row.Id);
            await FinishAsync(row.Id, FirewallChangeState.Confirmed, cause: null, error: null);
            await alerts.ResolveAsync(AlertKind.FirewallRolledBack, AlertResource, CancellationToken.None);
            await alerts.ResolveAsync(AlertKind.FirewallRollbackFailed, AlertResource, CancellationToken.None);
            return ToInfo(await FindAsync(row.Id, CancellationToken.None));
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<FirewallChangeSetInfo> RevertAsync(Guid changeSetId, FirewallCaller caller, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(caller);
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var row = await FindAsync(changeSetId, cancellationToken);
            if (row.State == FirewallChangeState.RolledBack)
            {
                return ToInfo(row);
            }

            if (row.State != FirewallChangeState.AwaitingConfirmation)
            {
                throw new FirewallRefusedException($"Only a change waiting for its confirmation can be reverted; this one {StateWords(row)}.");
            }

            var (outcome, error) = await RevertNowAsync(row.Id);
            switch (outcome)
            {
                case FirewallRevertOutcome.AlreadyConfirmed:
                    await FinishAsync(row.Id, FirewallChangeState.Confirmed, cause: null, error: null);
                    throw new FirewallRefusedException("This change was confirmed already, so it stays.");
                case FirewallRevertOutcome.Failed:
                    await FailedRollbackAsync(row, FirewallRollbackCause.User, error);
                    throw new FirewallRefusedException(
                        $"Putting the old rules back failed: {error} The rollback timer tries again at the deadline.");
                default:
                    await DisarmQuietlyAsync(row.Id);
                    await FinishAsync(row.Id, FirewallChangeState.RolledBack, FirewallRollbackCause.User, error: null);
                    return ToInfo(await FindAsync(row.Id, CancellationToken.None));
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// A change the core makes by itself, with nobody there to confirm it: the origin lock's
    /// daily refresh (E14). It is held to what cannot touch SSH: only allow rules for single
    /// ports in <paramref name="ports"/> are added or removed, and only while sshd listens on
    /// none of them. The rules are saved first and put back at once if a step fails or the
    /// read-back does not show the change; otherwise the change is recorded as confirmed, by
    /// the core, and audited.
    /// </summary>
    public async Task<FirewallChangeSetInfo> ApplyUnattendedAsync(
        IReadOnlyList<FirewallChange> changes,
        string requestedBy,
        IReadOnlyCollection<int> ports,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(ports);
        await _gate.WaitAsync(cancellationToken);
        try
        {
            if (await PendingAsync(cancellationToken) is { } pending)
            {
                throw new FirewallRefusedException(
                    $"Another firewall change is waiting for its confirmation (\"{pending.Summary}\"), so the core changes nothing by itself now.");
            }

            var backend = backends.Current();
            var plan = FirewallChangePlanner.Plan(await backend.ReadAsync(cancellationToken), changes);
            if (plan.Enable is not null || plan.DefaultIncoming is not null
                || plan.Added.Concat(plan.Removed).Any(rule => !IsAllowFor(rule, ports)))
            {
                throw new FirewallRefusedException(
                    $"The core only changes allow rules for ports {string.Join(", ", ports)} by itself; anything else needs a person and a confirmation.");
            }

            var ssh = await sshd.ReadAsync(cancellationToken);
            if (ssh.Ports.Length == 0 || ssh.Ports.Any(ports.Contains))
            {
                throw new FirewallRefusedException(
                    ssh.Ports.Length == 0
                        ? "The core cannot tell which port SSH listens on, so it changes nothing by itself."
                        : "SSH listens on one of these ports, so the core changes nothing there by itself.");
            }

            var steps = backend.Steps(plan);
            if (steps.Count == 0)
            {
                throw new FirewallRefusedException("Nothing would change.");
            }

            return await ApplyNowAsync(backend, plan, steps, changes, requestedBy);
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task<FirewallChangeSetInfo> ApplyNowAsync(
        IFirewallBackend backend,
        FirewallChangePlan plan,
        IReadOnlyList<FirewallStep> steps,
        IReadOnlyList<FirewallChange> changes,
        string requestedBy)
    {
        var token = CancellationToken.None;
        var id = Guid.NewGuid();
        var snapshot = await backend.SnapshotAsync(token) with { TakenAtUnixMs = Now };
        Files(id).WriteSnapshot(snapshot);
        await using (var db = await contexts.CreateDbContextAsync(token))
        {
            db.FirewallChangeSets.Add(new FirewallChangeSet
            {
                Id = id,
                Backend = backend.Kind,
                State = FirewallChangeState.Applying,
                Summary = Clip(plan.Summary, MaxSummaryLength),
                Changes = JsonSerializer.Serialize(changes, CoreJson.Options),
                Commands = JsonSerializer.Serialize(steps.Select(step => step.Display).ToArray(), CoreJson.Options),
                CreatedAt = Now,
                RequestedByName = Clip(requestedBy, 256),
                AppliedOver = "core",
            });
            await db.SaveChangesAsync(token);
        }

        try
        {
            await backend.ApplyAsync(plan, steps, line => LogStep(logger, id, line), token);
            await VerifyAsync(backend, plan, token);
        }
        catch (Exception failure) when (IsMachineFailure(failure))
        {
            LogApplyFailed(logger, id, failure);
            try
            {
                await backend.RestoreAsync(snapshot, line => LogStep(logger, id, line), token);
            }
            catch (Exception restore) when (IsMachineFailure(restore))
            {
                await FailedRollbackAsync(await FindAsync(id, token), FirewallRollbackCause.ApplyFailed, $"{failure.Message} Putting the old rules back failed too: {restore.Message}");
                throw new FirewallRefusedException($"The change failed ({failure.Message}), and putting the old rules back failed too: {restore.Message}");
            }

            await FinishAsync(id, FirewallChangeState.RolledBack, FirewallRollbackCause.ApplyFailed, failure.Message);
            throw new FirewallRefusedException($"The change failed, so the firewall was put back as it was: {failure.Message}");
        }

        await FinishAsync(id, FirewallChangeState.Confirmed, cause: null, error: null);
        await audit.AppendAsync(
            new AuditEntry(
                "firewall.apply",
                AuditResult.Success,
                Target: id.ToString("D"),
                Parameters: new Dictionary<string, string?> { ["summary"] = plan.Summary, ["unattended"] = requestedBy }),
            token);
        return ToInfo(await FindAsync(id, token));
    }

    private static bool IsAllowFor(FirewallRule rule, IReadOnlyCollection<int> ports) =>
        rule is { Action: FirewallAction.Allow, PortList: null, Outgoing: false, Routed: false }
        && rule.Ports is { IsSingle: true } single
        && ports.Contains(single.From);

    /// <summary>
    /// Looks at every change set still open and settles what the timer or a restart decided. A
    /// change whose timer is gone without a decision (a reboot ends transient units) is rolled back
    /// by the core itself, and so is one whose timer is long past its time.
    /// </summary>
    public async Task ReconcileAsync(CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            List<FirewallChangeSet> open;
            await using (var db = await contexts.CreateDbContextAsync(cancellationToken))
            {
                open = await db.FirewallChangeSets.AsNoTracking()
                    .Where(change => change.State == FirewallChangeState.Applying
                        || change.State == FirewallChangeState.AwaitingConfirmation
                        || change.State == FirewallChangeState.RollbackFailed)
                    .ToListAsync(cancellationToken);
            }

            foreach (var row in open)
            {
                await ReconcileAsync(row, cancellationToken);
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    // A delay rather than a PeriodicTimer: a PeriodicTimer catches up on every interval a clock
    // jump skipped, so a test that moves its fake clock 30 days on ran this half a million times.
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (true)
        {
            await ReconcileQuietlyAsync(stoppingToken);
            await Task.Delay(options.MonitorInterval, time, stoppingToken);
        }
    }

    private async Task ReconcileQuietlyAsync(CancellationToken cancellationToken)
    {
        try
        {
            await ReconcileAsync(cancellationToken);
        }
        catch (Exception failure) when (failure is not OperationCanceledException and not OutOfMemoryException)
        {
            LogReconcileFailed(logger, failure);
        }
    }

    private async Task ReconcileAsync(FirewallChangeSet row, CancellationToken cancellationToken)
    {
        var files = Files(row.Id);
        switch (files.Decision())
        {
            case FirewallDecision.Confirmed:
                if (row.State != FirewallChangeState.RollbackFailed)
                {
                    await FinishAsync(row.Id, FirewallChangeState.Confirmed, cause: null, error: null);
                }

                return;
            case FirewallDecision.Reverted:
                if (files.ReadResult() is { } result && (result.Restored || row.State != FirewallChangeState.RollbackFailed))
                {
                    await SettleRevertedAsync(row, files, row.RolledBackBy ?? FirewallRollbackCause.Timer, cancellationToken);
                }

                return;
        }

        if (row.State == FirewallChangeState.RollbackFailed)
        {
            return;
        }

        var deadline = row.DeadlineAt ?? row.CreatedAt;
        var state = await timer.StateAsync(row.Id, cancellationToken);
        var overdue = Now > deadline + (long)options.Grace.TotalMilliseconds;
        if ((state is ScheduleState.Waiting or ScheduleState.Running or ScheduleState.Unknown) && !overdue)
        {
            return;
        }

        // The timer is gone without deciding (a reboot ends transient units), or it is long overdue.
        var cause = state == ScheduleState.Gone && Now < deadline ? FirewallRollbackCause.Restart : FirewallRollbackCause.Timer;
        LogRevertingItself(logger, row.Id, state);
        var (outcome, error) = await RevertNowAsync(row.Id);
        switch (outcome)
        {
            case FirewallRevertOutcome.AlreadyConfirmed:
                await FinishAsync(row.Id, FirewallChangeState.Confirmed, cause: null, error: null);
                break;
            case FirewallRevertOutcome.Failed:
                await FailedRollbackAsync(row, cause, error);
                break;
            default:
                await DisarmQuietlyAsync(row.Id);
                await SettleRevertedAsync(row, files, cause, cancellationToken);
                break;
        }
    }

    private async Task<FirewallChangeSetInfo> SafeApplyAsync(Prepared prepared, FirewallChangeRequest request, FirewallCaller caller, bool overridden)
    {
        // Past this point hanging up changes nothing: a change that has started is finished or put back.
        var token = CancellationToken.None;
        var (backend, plan, steps, _) = prepared;
        var id = Guid.NewGuid();
        var files = Files(id);
        var snapshot = await backend.SnapshotAsync(token) with { TakenAtUnixMs = Now };
        files.WriteSnapshot(snapshot);

        var now = Now;
        await using (var db = await contexts.CreateDbContextAsync(token))
        {
            db.FirewallChangeSets.Add(new FirewallChangeSet
            {
                Id = id,
                Backend = backend.Kind,
                State = FirewallChangeState.Applying,
                Summary = Clip(plan.Summary, MaxSummaryLength),
                Changes = JsonSerializer.Serialize(request.Changes, CoreJson.Options),
                Commands = JsonSerializer.Serialize(steps.Select(step => step.Display).ToArray(), CoreJson.Options),
                CreatedAt = now,
                DeadlineAt = now + (long)options.ConfirmWindow.TotalMilliseconds,
                RequestedBy = caller.UserId,
                RequestedByName = caller.UserName,
                DeviceId = caller.DeviceId,
                AppliedOver = Clip(caller.Connection.Key, 200),
                AppliedOverSsh = caller.Connection.Ssh is not null,
                AppliedFrom = caller.Connection.Ssh?.Client.ToString(),
                GuardOverridden = overridden,
            });
            await db.SaveChangesAsync(token);
        }

        try
        {
            await timer.ArmAsync(id, options.ConfirmWindow, token);
        }
        catch (Exception failure) when (IsMachineFailure(failure))
        {
            var message = $"The rollback timer could not be armed, so nothing was changed: {failure.Message}";
            await FinishAsync(id, FirewallChangeState.Failed, cause: null, message);
            throw new FirewallRefusedException(message);
        }

        var deadline = Now + (long)options.ConfirmWindow.TotalMilliseconds;
        await UpdateAsync(id, row => row.DeadlineAt = deadline);
        try
        {
            await backend.ApplyAsync(plan, steps, line => LogStep(logger, id, line), token);
            await VerifyAsync(backend, plan, token);
        }
        catch (Exception failure) when (IsMachineFailure(failure))
        {
            LogApplyFailed(logger, id, failure);
            var (outcome, error) = await RevertNowAsync(id);
            var row = await FindAsync(id, token);
            if (outcome is FirewallRevertOutcome.Restored or FirewallRevertOutcome.AlreadyReverted)
            {
                await DisarmQuietlyAsync(id);
                await FinishAsync(id, FirewallChangeState.RolledBack, FirewallRollbackCause.ApplyFailed, failure.Message);
                throw new FirewallRefusedException($"The change failed, so the firewall was put back as it was: {failure.Message}");
            }

            await FailedRollbackAsync(row, FirewallRollbackCause.ApplyFailed, $"{failure.Message} Putting the old rules back failed too: {error}");
            throw new FirewallRefusedException(
                $"The change failed ({failure.Message}), and putting the old rules back failed too: {error} "
                + "The rollback timer tries again at the deadline; if SSH stops answering, use the server's console.");
        }

        if (files.Decision() == FirewallDecision.Reverted)
        {
            // The timer fired while the steps still ran, so the later steps landed on the restored
            // rules. Put the saved rules back once more, now that nothing else is changing them.
            var row = await FindAsync(id, token);
            try
            {
                await backend.RestoreAsync(snapshot, line => LogStep(logger, id, line), token);
            }
            catch (Exception failure) when (IsMachineFailure(failure))
            {
                await FailedRollbackAsync(row, FirewallRollbackCause.Timer, failure.Message);
                throw new FirewallRefusedException($"The change took longer than the confirm window, and putting the old rules back failed: {failure.Message}");
            }

            await FinishAsync(id, FirewallChangeState.RolledBack, FirewallRollbackCause.Timer, "The change took longer than the confirm window.");
            throw new FirewallRefusedException(
                "The change took longer than the confirm window, so the rollback timer fired and the old rules are back. Try a smaller change.");
        }

        await UpdateAsync(id, row => row.State = FirewallChangeState.AwaitingConfirmation);
        return ToInfo(await FindAsync(id, token));
    }

    /// <summary>Reads the firewall back and checks the change is there; anything missing fails the change.</summary>
    private static async Task VerifyAsync(IFirewallBackend backend, FirewallChangePlan plan, CancellationToken cancellationToken)
    {
        var after = await backend.ReadAsync(cancellationToken);
        var problems = new List<string>();
        if (plan.Enable is { } on && after.Active != on)
        {
            problems.Add(on ? "the firewall is not running" : "the firewall is still running");
        }

        if (plan.DefaultIncoming is { } policy && after.DefaultIncoming != policy)
        {
            problems.Add($"the default for incoming traffic is {FirewallEvaluation.Word(after.DefaultIncoming)}, not {FirewallEvaluation.Word(policy)}");
        }

        problems.AddRange(plan.Added
            .Where(rule => after.Rules.All(existing => existing.Id != rule.Id))
            .Select(rule => $"\"{FirewallEvaluation.Describe(rule)}\" is not in the firewall's rules"));
        problems.AddRange(plan.Removed
            .Where(rule => after.Rules.Any(existing => existing.Id == rule.Id))
            .Select(rule => $"\"{FirewallEvaluation.Describe(rule)}\" is still there"));
        if (problems.Count > 0)
        {
            throw new FirewallStepFailedException($"After the change, {string.Join("; ", problems)}.");
        }
    }

    private async Task<Prepared> PrepareAsync(FirewallChangeRequest? request, FirewallCaller caller, CancellationToken cancellationToken)
    {
        if (request?.Changes is null)
        {
            throw new FirewallRefusedException($"A change set has 1 to {FirewallChangePlanner.MaxChanges.ToString(CultureInfo.InvariantCulture)} changes.");
        }

        SshEndpoint? told = null;
        if (!string.IsNullOrWhiteSpace(request.SshConnection) && !SshEndpoint.TryParse(request.SshConnection, out told))
        {
            throw new FirewallRefusedException(
                "The SSH connection the app sent is not in $SSH_CONNECTION's form (client address, client port, server address, "
                + "server port), so the core cannot check that SSH stays open.");
        }

        var backend = backends.Current();
        FirewallState current;
        try
        {
            current = await backend.ReadAsync(cancellationToken);
        }
        catch (Exception failure) when (IsMachineFailure(failure))
        {
            throw new FirewallRefusedException($"The core could not read the firewall, so it changes nothing: {failure.Message}");
        }

        var plan = FirewallChangePlanner.Plan(current, request.Changes);
        var steps = backend.Steps(plan);
        var ssh = await sshd.ReadAsync(cancellationToken);
        var known = new[] { caller.Connection.Ssh, told }.OfType<SshEndpoint>().ToList();
        var access = new SshAccess(
            [.. known.Select(endpoint => endpoint.Client).Distinct()],
            [.. known.Select(endpoint => endpoint.ServerPort).Distinct()],
            ssh.Ports,
            known.Select(endpoint => endpoint.Server).FirstOrDefault());
        var verdict = LockoutGuard.Check(plan.Result, access);
        if (caller.Connection.Ssh is null)
        {
            // Without knowing the applying SSH connection, a confirmation over a new one cannot be told apart.
            verdict = new FirewallGuardVerdict(
                true,
                [
                    "The core could not tell which SSH connection this change came over, so it cannot be sure the confirmation "
                    + "comes over a new one.",
                    .. verdict.Reasons,
                ],
                verdict.Checked,
                verdict.ConfirmationPhrase ?? LockoutGuard.UnknownPhrase);
        }

        return new Prepared(backend, plan, steps, verdict);
    }

    /// <summary>Runs the revert program now; the change set's files say how it went.</summary>
    private async Task<(FirewallRevertOutcome Outcome, string? Error)> RevertNowAsync(Guid id)
    {
        try
        {
            await timer.RevertNowAsync(id, CancellationToken.None);
        }
        catch (Exception failure) when (IsMachineFailure(failure))
        {
            return (FirewallRevertOutcome.Failed, $"The revert program could not run: {failure.Message}");
        }

        var files = Files(id);
        if (files.Decision() == FirewallDecision.Confirmed)
        {
            return (FirewallRevertOutcome.AlreadyConfirmed, null);
        }

        return files.ReadResult() switch
        {
            { Restored: true } => (FirewallRevertOutcome.Restored, null),
            { } result => (FirewallRevertOutcome.Failed, result.Error),
            null => (FirewallRevertOutcome.Failed, $"The revert program left no result; its journal has the details (journalctl -u '{SystemdFirewallTimer.Purpose}*')."),
        };
    }

    /// <summary>The revert ran (the timer's, or the core's after a restart): record it, raise the alert, audit it.</summary>
    private async Task SettleRevertedAsync(FirewallChangeSet row, FirewallChangeFiles files, FirewallRollbackCause cause, CancellationToken cancellationToken)
    {
        var result = files.ReadResult();
        if (result is null)
        {
            // Still putting the rules back; the next look finds the outcome.
            return;
        }

        if (!result.Restored)
        {
            await FailedRollbackAsync(row, cause, result.Error);
            return;
        }

        await FinishAsync(row.Id, FirewallChangeState.RolledBack, cause, error: null);
        await alerts.ResolveAsync(AlertKind.FirewallRollbackFailed, AlertResource, cancellationToken);
        if (cause is FirewallRollbackCause.Timer or FirewallRollbackCause.Restart)
        {
            await alerts.RaiseAsync(
                AlertKind.FirewallRolledBack,
                AlertResource,
                AlertSeverity.Warning,
                cause == FirewallRollbackCause.Restart
                    ? $"The server restarted before a firewall change was confirmed, so the rules from before it were put back: {row.Summary}."
                    : $"A firewall change was not confirmed within {WindowSeconds.ToString(CultureInfo.InvariantCulture)} seconds, so the rules from before it were put back: {row.Summary}.",
                cancellationToken);
        }

        await audit.AppendAsync(
            new AuditEntry(
                "firewall.rolled-back",
                AuditResult.Success,
                Target: row.Id.ToString("D"),
                Parameters: new Dictionary<string, string?> { ["cause"] = Jobs.JobEngine.KindName(cause) }),
            cancellationToken);
    }

    private async Task FailedRollbackAsync(FirewallChangeSet row, FirewallRollbackCause cause, string? error)
    {
        await FinishAsync(row.Id, FirewallChangeState.RollbackFailed, cause, error);
        await alerts.RaiseAsync(
            AlertKind.FirewallRollbackFailed,
            AlertResource,
            AlertSeverity.Critical,
            $"A firewall change could not be rolled back ({row.Summary}): {error} Check the firewall from the server's console.",
            CancellationToken.None);
        await audit.AppendAsync(
            new AuditEntry(
                "firewall.rolled-back",
                AuditResult.Failed,
                Target: row.Id.ToString("D"),
                Parameters: new Dictionary<string, string?> { ["cause"] = Jobs.JobEngine.KindName(cause) }),
            CancellationToken.None);
    }

    private async Task DisarmQuietlyAsync(Guid id)
    {
        try
        {
            await timer.DisarmAsync(id, CancellationToken.None);
        }
        catch (Exception failure) when (IsMachineFailure(failure))
        {
            // The decision file already holds; a timer that still fires finds it and does nothing.
            LogDisarmFailed(logger, id, failure);
        }
    }

    private async Task<FirewallChangeSet?> PendingAsync(CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        return await db.FirewallChangeSets.AsNoTracking()
            .Where(change => change.State == FirewallChangeState.Applying || change.State == FirewallChangeState.AwaitingConfirmation)
            .OrderByDescending(change => change.CreatedAt)
            .FirstOrDefaultAsync(cancellationToken);
    }

    private async Task<FirewallChangeSet> FindAsync(Guid id, CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        return await db.FirewallChangeSets.AsNoTracking().FirstOrDefaultAsync(change => change.Id == id, cancellationToken)
            ?? throw new FirewallRefusedException("There is no such firewall change.");
    }

    private async Task UpdateAsync(Guid id, Action<FirewallChangeSet> change)
    {
        await using var db = await contexts.CreateDbContextAsync(CancellationToken.None);
        var row = await db.FirewallChangeSets.FirstAsync(candidate => candidate.Id == id, CancellationToken.None);
        change(row);
        await db.SaveChangesAsync(CancellationToken.None);
    }

    private Task FinishAsync(Guid id, FirewallChangeState state, FirewallRollbackCause? cause, string? error) =>
        UpdateAsync(id, row =>
        {
            row.State = state;
            row.RolledBackBy = cause ?? row.RolledBackBy;
            row.Error = error is null ? row.Error : Clip(error, MaxErrorLength);
            row.FinishedAt = Now;
        });

    private FirewallChangeFiles Files(Guid id) => new(directories.Data, id);

    private static FirewallChangeSetInfo ToInfo(FirewallChangeSet row) => new(
        row.Id,
        row.State,
        row.Backend,
        row.Summary,
        JsonSerializer.Deserialize<string[]>(row.Commands, CoreJson.Options) ?? [],
        row.CreatedAt,
        row.GuardOverridden,
        row.DeadlineAt,
        row.FinishedAt,
        row.RequestedByName,
        row.AppliedFrom,
        row.RolledBackBy,
        row.Error);

    private static string StateWords(FirewallChangeSet row) => row.State switch
    {
        FirewallChangeState.Applying => "is still being applied",
        FirewallChangeState.RolledBack => "was rolled back already",
        FirewallChangeState.RollbackFailed => "could not be rolled back and needs a look from the server's console",
        FirewallChangeState.Failed => "never took effect",
        FirewallChangeState.Confirmed => "was confirmed already",
        _ => "is waiting for its confirmation",
    };

    /// <summary>What can go wrong on the machine itself: a program failing or missing, a file that will not write.</summary>
    private static bool IsMachineFailure(Exception failure) =>
        failure is FirewallStepFailedException or FirewallRefusedException or ProcessStartException or ProcessFailedException
            or IOException or UnauthorizedAccessException;

    private static string Clip(string text, int length) => text.Length <= length ? text : text[..(length - 1)] + "…";

    private sealed record Prepared(IFirewallBackend Backend, FirewallChangePlan Plan, IReadOnlyList<FirewallStep> Steps, FirewallGuardVerdict Verdict);

    [LoggerMessage(Level = LogLevel.Information, Message = "Firewall change {ChangeSetId}: {Line}")]
    private static partial void LogStep(ILogger logger, Guid changeSetId, string line);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Firewall change {ChangeSetId} failed; putting the saved rules back.")]
    private static partial void LogApplyFailed(ILogger logger, Guid changeSetId, Exception error);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Could not disarm the rollback timer of firewall change {ChangeSetId}.")]
    private static partial void LogDisarmFailed(ILogger logger, Guid changeSetId, Exception error);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Firewall change {ChangeSetId} was not decided and its timer is {State}; rolling it back.")]
    private static partial void LogRevertingItself(ILogger logger, Guid changeSetId, ScheduleState state);

    [LoggerMessage(Level = LogLevel.Error, Message = "Could not check the open firewall changes.")]
    private static partial void LogReconcileFailed(ILogger logger, Exception error);
}
