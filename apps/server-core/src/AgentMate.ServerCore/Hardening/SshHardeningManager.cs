using AgentMate.ServerCore.Contracts;
using AgentMate.ServerCore.Execution;
using AgentMate.ServerCore.Firewall;
using AgentMate.ServerCore.Hosting;

namespace AgentMate.ServerCore.Hardening;

internal sealed class SshHardeningRefusedException(string message) : Exception(message);

/// <summary>Who asks for an SSH change, and over which connection.</summary>
internal sealed record SshCaller(string UserName, CallerConnection Connection);

/// <summary>
/// Turns SSH password login off and keeps root to keys, without ever locking the app out:
/// <list type="number">
/// <item>The SSH connection asking must have signed in with a key (sshd's log says how it signed in).
/// The app sends the request over a connection it has just opened with its key only.</item>
/// <item>The old drop-in is saved and a systemd timer that puts it back in a minute is armed, before
/// anything changes.</item>
/// <item>The new drop-in is written and checked (`sshd -t`, then `sshd -T` to see it really takes),
/// and only then is sshd reloaded. Open connections stay open.</item>
/// <item>Confirming must come over another new connection that also signed in with a key after the
/// change: that shows a new key login still gets in. Without it, the timer reverts.</item>
/// </list>
/// One change waits at a time.
/// </summary>
internal sealed partial class SshHardeningManager(
    ISshMachine machine,
    ISshLoginLog logins,
    ISshHardeningTimer timer,
    CoreDirectories directories,
    SshHardeningOptions options,
    TimeProvider time,
    ILogger<SshHardeningManager> logger) : BackgroundService
{
    private const int MaxListed = 20;

    private readonly SemaphoreSlim _gate = new(1, 1);

    private long Now => time.GetUtcNow().ToUnixTimeMilliseconds();

    public int WindowSeconds => (int)Math.Round(options.ConfirmWindow.TotalSeconds);

    public override void Dispose()
    {
        _gate.Dispose();
        base.Dispose();
    }

    public Task<SshPolicyInfo> PolicyAsync(CancellationToken cancellationToken) => machine.ReadAsync(cancellationToken);

    public async Task<SshLoginProof> ProofAsync(CallerConnection connection, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(connection);
        return connection.Ssh is { } ssh
            ? SshLoginLines.Judge(ssh, await logins.FindAsync(ssh, cancellationToken))
            : SshLoginLines.Judge(null, null);
    }

    /// <summary>The change waiting for its confirmation, if one is.</summary>
    public SshHardeningChangeInfo? Pending() =>
        History().FirstOrDefault(change => change.State == SshHardeningState.AwaitingConfirmation);

    public SshHardeningChangeInfo[] History() =>
        [.. SshChangeFiles.All(directories.Data).Take(MaxListed).Select(files => files.Info()).OfType<SshHardeningChangeInfo>()];

    public async Task<SshHardeningPreview> PreviewAsync(SshHardeningRequest request, SshCaller caller, CancellationToken cancellationToken)
    {
        Check(request);
        ArgumentNullException.ThrowIfNull(caller);
        var previous = machine.ReadDropIn();
        var wanted = SshdPolicy.Merge(previous, request);
        var content = SshdPolicy.Render(wanted);
        var proof = await ProofAsync(caller.Connection, cancellationToken);
        var pending = Pending();
        var notes = new List<string>();
        if (pending is not null)
        {
            notes.Add($"Another SSH change waits for its confirmation (\"{pending.Summary}\"). Keep or revert it first.");
        }

        if (content == previous)
        {
            notes.Add("The drop-in already holds these settings.");
        }

        notes.Add($"Connections open now stay open. The change rolls back by itself after {WindowSeconds} seconds unless a new SSH connection that signs in with a key keeps it.");
        return new SshHardeningPreview(
            SshdPolicy.Describe(wanted),
            SshdPolicy.DropInPath,
            content,
            [$"write {SshdPolicy.DropInPath}", "sshd -t", "sshd -T", $"systemctl reload {machine.ReloadUnit}"],
            proof,
            proof.KeyLoginProven && pending is null && content != previous,
            WindowSeconds,
            [.. notes]);
    }

    public async Task<SshHardeningChangeInfo> ApplyAsync(SshHardeningRequest request, SshCaller caller, CancellationToken cancellationToken)
    {
        Check(request);
        ArgumentNullException.ThrowIfNull(caller);
        await _gate.WaitAsync(cancellationToken);
        try
        {
            if (Pending() is { } pending)
            {
                throw new SshHardeningRefusedException(
                    $"Another SSH change waits for its confirmation (\"{pending.Summary}\"). Keep or revert it first.");
            }

            var proof = await ProofAsync(caller.Connection, cancellationToken);
            if (!proof.KeyLoginProven)
            {
                throw new SshHardeningRefusedException($"Nothing was changed. {proof.Explanation}");
            }

            var previous = machine.ReadDropIn();
            var wanted = SshdPolicy.Merge(previous, request);
            var content = SshdPolicy.Render(wanted);
            if (content == previous)
            {
                throw new SshHardeningRefusedException("sshd already runs with these settings from AgentMate's drop-in.");
            }

            var id = Guid.NewGuid();
            var now = Now;
            var files = new SshChangeFiles(directories.Data, id);
            files.WriteSnapshot(new SshChangeSnapshot(
                id,
                SshdPolicy.Describe(wanted),
                previous,
                machine.ReloadUnit,
                caller.UserName,
                caller.Connection.Key,
                now,
                now + (long)options.ConfirmWindow.TotalMilliseconds));

            try
            {
                await timer.ArmAsync(id, options.ConfirmWindow, cancellationToken);
            }
            catch (ProcessFailedException failure)
            {
                files.Decide(SshDecision.Reverted);
                files.WriteResult(new SshRevertResult(true, SshRevertCause.Failed, Now, failure.Message, []));
                throw new SshHardeningRefusedException($"The rollback timer could not be set, so nothing was changed: {failure.Message}");
            }

            if (await ChangeAsync(content, wanted, cancellationToken) is { } problem)
            {
                await SshRevert.RunAsync(files, machine, SshRevertCause.Failed, time, CancellationToken.None, problem);
                await DisarmQuietlyAsync(id);
                throw new SshHardeningRefusedException($"{problem} The old settings are back.");
            }

            return files.Info()!;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<SshHardeningChangeInfo> ConfirmAsync(Guid changeId, SshCaller caller, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(caller);
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var files = new SshChangeFiles(directories.Data, changeId);
            var snapshot = files.ReadSnapshot() ?? throw new SshHardeningRefusedException("There is no such SSH change.");
            switch (files.Decision())
            {
                case SshDecision.Confirmed:
                    return files.Info()!;
                case SshDecision.Reverted:
                    throw new SshHardeningRefusedException("This SSH change was already rolled back.");
            }

            if (Now > snapshot.DeadlineUnixMs)
            {
                throw new SshHardeningRefusedException("Too late: the change is past its deadline and rolls back.");
            }

            if (caller.Connection.Ssh is null || caller.Connection.Key == snapshot.AppliedFrom)
            {
                throw new SshHardeningRefusedException(
                    "Keep it over a new SSH connection: this is the one that made the change, so it proves nothing about the next login.");
            }

            var proof = await ProofAsync(caller.Connection, cancellationToken);
            if (!proof.KeyLoginProven)
            {
                throw new SshHardeningRefusedException($"A new connection has to show that key login still works. {proof.Explanation}");
            }

            if (proof.AtUnixMs is long at && at < snapshot.CreatedAtUnixMs)
            {
                throw new SshHardeningRefusedException(
                    "This connection signed in before the change, so it does not show that a new key login gets in.");
            }

            if (files.Decide(SshDecision.Confirmed) != SshDecision.Confirmed)
            {
                throw new SshHardeningRefusedException("The change was rolled back just before this confirmation arrived.");
            }

            await DisarmQuietlyAsync(changeId);
            return files.Info()!;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<SshHardeningChangeInfo> RevertAsync(Guid changeId, CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var files = new SshChangeFiles(directories.Data, changeId);
            if (files.ReadSnapshot() is null)
            {
                throw new SshHardeningRefusedException("There is no such SSH change.");
            }

            var outcome = await SshRevert.RunAsync(files, machine, SshRevertCause.Manual, time, cancellationToken);
            switch (outcome)
            {
                case SshRevertOutcome.AlreadyConfirmed:
                    throw new SshHardeningRefusedException("This change was kept already. Make another change to undo it.");
                case SshRevertOutcome.Failed:
                    throw new SshHardeningRefusedException($"The old settings could not be put back: {files.ReadResult()?.Error}");
            }

            await DisarmQuietlyAsync(changeId);
            return files.Info()!;
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Reverts a change nobody decided whose timer should have fired by now.</summary>
    public async Task SettleAsync(CancellationToken cancellationToken)
    {
        foreach (var files in SshChangeFiles.All(directories.Data).Take(MaxListed))
        {
            if (files.Decision() is not null || files.ReadSnapshot() is not { } snapshot
                || Now < snapshot.DeadlineUnixMs + (long)options.Grace.TotalMilliseconds)
            {
                continue;
            }

            var outcome = await SshRevert.RunAsync(files, machine, SshRevertCause.Timer, time, cancellationToken);
            LogSettled(logger, snapshot.Id, outcome);
        }
    }

    // A delay rather than a PeriodicTimer: a PeriodicTimer catches up on every interval a clock
    // jump skipped, so a test that moves its fake clock 30 days on ran this half a million times.
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (true)
        {
            try
            {
                await SettleAsync(stoppingToken);
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                LogSettleFailed(logger, error);
            }

            await Task.Delay(options.MonitorInterval, time, stoppingToken);
        }
    }

    private static void Check(SshHardeningRequest? request)
    {
        if (request is null || !(request.DisablePasswordLogin || request.RestrictRootLogin))
        {
            throw new SshHardeningRefusedException("Say what to change: password login, root login or both.");
        }
    }

    /// <summary>Writes, checks and reloads. A problem in words, or null when sshd now runs the new settings.</summary>
    private async Task<string?> ChangeAsync(string content, ManagedSshSettings wanted, CancellationToken cancellationToken)
    {
        try
        {
            machine.WriteDropIn(content);
            if (await machine.TestAsync(cancellationToken) is { } complaint)
            {
                return $"sshd refused the new settings: {complaint}.";
            }

            var effective = await machine.ReadAsync(cancellationToken);
            if (effective.Error is { } error)
            {
                return error;
            }

            if (!SshdPolicy.Holds(effective, wanted))
            {
                return $"sshd would not run with the new settings: an earlier setting wins over {SshdPolicy.DropInPath}, or sshd does not read that folder.";
            }

            await machine.ReloadAsync(machine.ReloadUnit, cancellationToken);
            return null;
        }
        catch (Exception failure) when (failure is IOException or UnauthorizedAccessException or ProcessFailedException or ProcessStartException)
        {
            return failure.Message;
        }
    }

    private async Task DisarmQuietlyAsync(Guid changeId)
    {
        try
        {
            await timer.DisarmAsync(changeId, CancellationToken.None);
        }
        catch (ProcessFailedException error)
        {
            // The change is decided; a timer that still fires finds the decision and does nothing.
            LogDisarmFailed(logger, changeId, error);
        }
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "SSH change {ChangeId} was past its deadline undecided; the core reverted it: {Outcome}")]
    private static partial void LogSettled(ILogger logger, Guid changeId, SshRevertOutcome outcome);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Could not look at the SSH changes")]
    private static partial void LogSettleFailed(ILogger logger, Exception error);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Could not stop the rollback timer of SSH change {ChangeId}")]
    private static partial void LogDisarmFailed(ILogger logger, Guid changeId, Exception error);
}
