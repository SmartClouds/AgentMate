using System.Globalization;
using System.IO.Pipelines;
using System.Security.Cryptography;
using Hangfire;
using Hangfire.States;
using Microsoft.EntityFrameworkCore;
using Runova.ServerCore.Alerts;
using Runova.ServerCore.Audit;
using Runova.ServerCore.Backups.Destinations;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Hosting;

namespace Runova.ServerCore.Backups;

/// <summary>Where a run's work goes next: Hangfire in the core, inline in tests.</summary>
internal interface IBackupJobQueue
{
    void EnqueueRun(Guid runId);

    void EnqueueUpload(Guid runId, Guid destinationId);
}

/// <summary>Runs and uploads as Hangfire jobs on the backups queue.</summary>
internal sealed class HangfireBackupQueue(IBackgroundJobClient jobs) : IBackupJobQueue
{
    public void EnqueueRun(Guid runId) =>
        jobs.Create<BackupRunner>(runner => runner.RunAsync(runId, CancellationToken.None), new EnqueuedState(BackupRegistration.Queue));

    public void EnqueueUpload(Guid runId, Guid destinationId) =>
        jobs.Create<BackupRunner>(runner => runner.UploadAsync(runId, destinationId, CancellationToken.None), new EnqueuedState(BackupRegistration.Queue));
}

/// <summary>
/// Lets one backup be made at a time. One per core rather than a static: the tests run many cores
/// side by side in one process, and a static gate made each wait for the others' backups.
/// </summary>
internal sealed class BackupRunGate : IDisposable
{
    private readonly SemaphoreSlim _gate = new(1, 1);

    public Task WaitAsync(CancellationToken cancellationToken) => _gate.WaitAsync(cancellationToken);

    public void Release() => _gate.Release();

    public void Dispose() => _gate.Dispose();
}

/// <summary>
/// The Hangfire jobs a backup is made of (E28). A run makes one file: the whole server, encrypted
/// to the key ring as it is written (no plaintext copy on disk), in the state folder's
/// backup-runs/. Each destination then gets its own upload job, retried on its own up to
/// <see cref="MaxAttempts"/> times, so one that fails never holds up another. After an upload a
/// plan's retention runs on that destination. When every destination is done the run is closed:
/// the file is deleted, or handed to the E15 download store for an hour when the app asked for it.
/// Runs go one at a time on a core (<see cref="BackupRunGate"/>). A run that fails, or
/// that not every destination took, raises an alert for its plan (E30); the plan's next good run
/// resolves it.
/// </summary>
internal sealed class BackupRunner(
    IDbContextFactory<CoreDbContext> contexts,
    BackupCenter center,
    FullBackupComposer composer,
    IBackupDestinationFactory destinations,
    IBackupJobQueue queue,
    AuditLog audit,
    CoreDirectories directories,
    BackupService downloads,
    AlertCenter alerts,
    BackupRunGate gate,
    TimeProvider time)
{
    public const int MaxAttempts = 3;
    public const string RunsFolder = "backup-runs";

    private long Now => time.GetUtcNow().ToUnixTimeMilliseconds();

    private string Folder => Path.Combine(directories.Data, RunsFolder);

    /// <summary>Starts a run by hand: to the destinations named, or only for download. Refused before anything is queued.</summary>
    public async Task<BackupRunInfo> StartAsync(Guid? planId, Guid[] destinationIds, bool keepForDownload, Guid? userId, string? userName, CancellationToken cancellationToken)
    {
        BackupPlanRecord? plan = null;
        if (planId is { } id)
        {
            plan = await center.FindPlanAsync(id, cancellationToken) ?? throw new BackupRefusedException("That plan is gone.");
            destinationIds = await center.PlanDestinationsAsync(id, cancellationToken);
        }

        var run = await CreateRunAsync(plan, BackupTrigger.Manual, destinationIds, keepForDownload, userId, userName, cancellationToken);
        queue.EnqueueRun(run.Id);
        return await center.FindRunAsync(run.Id, cancellationToken) ?? throw new BackupRefusedException("The run is gone.");
    }

    /// <summary>A plan's scheduled run. Hangfire passes its own cancellation token in place of the one recorded.</summary>
    [AutomaticRetry(Attempts = 0)]
    public async Task RunPlanAsync(Guid planId, CancellationToken cancellationToken)
    {
        var plan = await center.FindPlanAsync(planId, cancellationToken);
        if (plan is not { Enabled: true })
        {
            return;
        }

        BackupRunRecord run;
        try
        {
            run = await CreateRunAsync(plan, BackupTrigger.Schedule, await center.PlanDestinationsAsync(planId, cancellationToken), false, null, null, cancellationToken);
        }
        catch (BackupRefusedException refused)
        {
            await audit.AppendAsync(new AuditEntry("backup.run", AuditResult.Failed, Target: planId.ToString("D"), Parameters: new Dictionary<string, string?> { ["reason"] = refused.Message }), cancellationToken);
            await AlertAsync(planId, plan.Name, BackupRunState.Failed, refused.Message);
            return;
        }

        await RunAsync(run.Id, cancellationToken);
    }

    /// <summary>Makes the run's file, then queues one upload per destination.</summary>
    [AutomaticRetry(Attempts = 0)]
    public async Task RunAsync(Guid runId, CancellationToken cancellationToken)
    {
        await gate.WaitAsync(cancellationToken);
        Guid[] targets;
        try
        {
            targets = await MakeAsync(runId, cancellationToken);
        }
        finally
        {
            gate.Release();
        }

        foreach (var destination in targets)
        {
            queue.EnqueueUpload(runId, destination);
        }

        if (targets.Length == 0)
        {
            await TryFinishAsync(runId, cancellationToken);
        }
    }

    /// <summary>
    /// Sends the run's file to one destination, then prunes the plan's old backups there. Failures
    /// before the last attempt are thrown so Hangfire tries again; the last one is recorded.
    /// </summary>
    [AutomaticRetry(Attempts = MaxAttempts - 1, DelaysInSeconds = [30, 300])]
    public async Task UploadAsync(Guid runId, Guid destinationId, CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var run = await db.BackupRuns.SingleOrDefaultAsync(r => r.Id == runId, cancellationToken);
        var target = await db.BackupRunTargets.SingleOrDefaultAsync(t => t.RunId == runId && t.DestinationId == destinationId, cancellationToken);
        if (run is null || target is null || target.State is BackupTargetState.Succeeded or BackupTargetState.Failed)
        {
            return;
        }

        target.Attempts++;
        target.State = BackupTargetState.Uploading;
        await db.SaveChangesAsync(cancellationToken);
        var gone = false;
        try
        {
            var destination = await center.OpenDestinationAsync(destinationId, cancellationToken);
            if (destination is null)
            {
                gone = true;
                throw new BackupDestinationException("The destination was removed after the run started.");
            }

            var file = RunFile(runId);
            var baseName = BackupNaming.BaseName(composer.HostName, run.StartedAt, run.Id);
            var parts = await BackupParts.DescribeAsync(file, destination.PartBytes, baseName, cancellationToken);
            var keyId = (await center.GetSecretAsync(cancellationToken)).KeyId ?? string.Empty;
            var manifest = new BackupManifestFile(
                BackupManifestFile.SchemaVersion,
                run.Id,
                run.PlanId,
                composer.HostName,
                run.StartedAt,
                run.SizeBytes ?? new FileInfo(file).Length,
                run.Sha256 ?? string.Empty,
                CoreVersion.Current,
                keyId,
                parts);
            await using (var opened = await destinations.OpenAsync(destination, cancellationToken))
            {
                await opened.UploadAsync(new BackupUpload(manifest, file, destination.PartBytes), cancellationToken);
                target.Pruned = run.PlanId is { } planId ? await PruneAsync(opened, planId, run.Id, cancellationToken) : 0;
            }

            target.State = BackupTargetState.Succeeded;
            target.Error = null;
            target.FinishedAt = Now;
            await center.RecordDestinationOutcomeAsync(destinationId, null, cancellationToken);
            await audit.AppendAsync(
                new AuditEntry("backup.upload", AuditResult.Success, Target: run.Id.ToString("D"), Parameters: new Dictionary<string, string?>
                {
                    ["destination"] = target.DestinationName,
                    ["parts"] = parts.Count.ToString(CultureInfo.InvariantCulture),
                    ["pruned"] = target.Pruned.ToString(CultureInfo.InvariantCulture),
                }),
                cancellationToken);
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            var message = error is BackupDestinationException or BackupRefusedException ? error.Message : $"The upload failed: {error.Message}";
            target.Error = message.Length > 1000 ? message[..1000] : message;
            var final = gone || target.Attempts >= MaxAttempts;
            target.State = final ? BackupTargetState.Failed : BackupTargetState.Pending;
            if (final)
            {
                target.FinishedAt = Now;
                await center.RecordDestinationOutcomeAsync(destinationId, target.Error, CancellationToken.None);
                await audit.AppendAsync(
                    new AuditEntry("backup.upload", AuditResult.Failed, Target: run.Id.ToString("D"), Parameters: new Dictionary<string, string?>
                    {
                        ["destination"] = target.DestinationName,
                        ["reason"] = target.Error,
                    }),
                    CancellationToken.None);
            }

            await db.SaveChangesAsync(CancellationToken.None);
            if (!final)
            {
                throw;
            }
        }

        await db.SaveChangesAsync(CancellationToken.None);
        await TryFinishAsync(runId, CancellationToken.None);
    }

    private async Task<BackupRunRecord> CreateRunAsync(
        BackupPlanRecord? plan,
        BackupTrigger trigger,
        Guid[] destinationIds,
        bool keepForDownload,
        Guid? userId,
        string? userName,
        CancellationToken cancellationToken)
    {
        if (destinationIds.Length == 0 && !keepForDownload)
        {
            throw new BackupRefusedException("Pick a destination for the backup, or download it.");
        }

        if (await center.GetKeyRingAsync(cancellationToken) is null)
        {
            throw new BackupRefusedException("Set the backup secret key first: every backup is encrypted with it.");
        }

        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var known = await db.BackupDestinations.Where(d => destinationIds.Contains(d.Id)).Select(d => new { d.Id, d.Name }).ToListAsync(cancellationToken);
        if (known.Count != destinationIds.Distinct().Count())
        {
            throw new BackupRefusedException("A destination the backup names is gone. Pick them again.");
        }

        var run = new BackupRunRecord
        {
            Id = Guid.NewGuid(),
            PlanId = plan?.Id,
            PlanName = plan?.Name,
            Trigger = trigger,
            State = BackupRunState.Running,
            StartedAt = Now,
            RequestedByName = userName,
            KeepForDownload = keepForDownload,
        };
        db.BackupRuns.Add(run);
        db.BackupRunTargets.AddRange(known.Select(d => new BackupRunTargetRecord { RunId = run.Id, DestinationId = d.Id, DestinationName = d.Name, State = BackupTargetState.Pending }));
        await db.SaveChangesAsync(cancellationToken);
        await audit.AppendAsync(
            new AuditEntry("backup.run.start", AuditResult.Success, userId, Target: run.Id.ToString("D"), Parameters: new Dictionary<string, string?>
            {
                ["trigger"] = trigger.ToString(),
                ["plan"] = plan?.Name,
                ["destinations"] = string.Join(", ", known.Select(d => d.Name)),
            }),
            cancellationToken);
        return run;
    }

    /// <summary>Writes the encrypted file and returns the destinations to send it to; a failure closes the run.</summary>
    private async Task<Guid[]> MakeAsync(Guid runId, CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var run = await db.BackupRuns.SingleOrDefaultAsync(r => r.Id == runId, cancellationToken);
        if (run is not { State: BackupRunState.Running } || run.Sha256 is not null)
        {
            return [];
        }

        var file = RunFile(runId);
        var partial = file + ".partial";
        try
        {
            var ring = await center.GetKeyRingAsync(cancellationToken) ?? throw new BackupRefusedException("The backup secret key was removed.");
            EnsureFolder();
            var work = Path.Combine(Folder, $".work-{runId:N}");
            Directory.CreateDirectory(work);
            try
            {
                await using var output = new FileStream(partial, FileMode.Create, FileAccess.Write, FileShare.None, 1024 * 1024, useAsync: true);
                await EncryptedComposeAsync(output, work, ring, run.StartedAt, cancellationToken);
                output.Flush(flushToDisk: true);
            }
            finally
            {
                BackupArchive.TryDelete(work);
            }

            File.Move(partial, file, overwrite: true);
            await using (var written = File.OpenRead(file))
            {
                run.Sha256 = Convert.ToHexStringLower(await SHA256.HashDataAsync(written, cancellationToken));
            }

            run.SizeBytes = new FileInfo(file).Length;
            await db.SaveChangesAsync(cancellationToken);
            return await db.BackupRunTargets.Where(t => t.RunId == runId).Select(t => t.DestinationId).ToArrayAsync(cancellationToken);
        }
        catch (Exception error) when (error is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            BackupArchive.TryDelete(partial);
            BackupArchive.TryDelete(file);
            run.State = BackupRunState.Failed;
            run.FinishedAt = Now;
            run.Error = Trim(error is BackupRefusedException ? error.Message : $"The backup could not be made: {error.Message}");
            await db.BackupRunTargets.Where(t => t.RunId == runId).ExecuteUpdateAsync(
                set => set.SetProperty(t => t.State, BackupTargetState.Failed).SetProperty(t => t.Error, "The backup was not made."),
                CancellationToken.None);
            await db.SaveChangesAsync(CancellationToken.None);
            await audit.AppendAsync(new AuditEntry("backup.run", AuditResult.Failed, Target: runId.ToString("D"), Parameters: new Dictionary<string, string?> { ["reason"] = run.Error }), CancellationToken.None);
            await AlertAsync(run.PlanId, run.PlanName, BackupRunState.Failed, run.Error);
            return [];
        }
    }

    /// <summary>The archive is encrypted as it is written, through a pipe, so no plaintext copy of the server ever lands on disk.</summary>
    private async Task EncryptedComposeAsync(Stream output, string work, BackupKeyRing ring, long createdAt, CancellationToken cancellationToken)
    {
        var pipe = new Pipe(new PipeOptions(pauseWriterThreshold: 8 * 1024 * 1024, resumeWriterThreshold: 4 * 1024 * 1024));
        var writing = Task.Run(
            async () =>
            {
                Exception? failure = null;
                try
                {
                    await using var plain = pipe.Writer.AsStream(leaveOpen: true);
                    await composer.WriteAsync(plain, work, createdAt, cancellationToken);
                }
                catch (Exception error)
                {
                    failure = error;
                    throw;
                }
                finally
                {
                    await pipe.Writer.CompleteAsync(failure);
                }
            },
            cancellationToken);
        try
        {
            await using var reader = pipe.Reader.AsStream();
            await BackupCrypto.EncryptToKeyRingAsync(reader, output, ring, createdAt, cancellationToken);
        }
        finally
        {
            await writing;
        }
    }

    private async Task<int> PruneAsync(IBackupDestination destination, Guid planId, Guid justUploaded, CancellationToken cancellationToken)
    {
        var plan = await center.FindPlanAsync(planId, cancellationToken);
        if (plan is null)
        {
            return 0;
        }

        var held = await destination.ListAsync(cancellationToken);
        var doomed = RetentionPlanner.ToDelete(
            held.Select(m => new StoredBackup(m.BackupId, m.PlanId, m.CreatedAtUnixMs)),
            planId,
            new RetentionRule(plan.KeepLast, plan.KeepDays),
            justUploaded,
            Now);
        foreach (var manifest in held.Where(m => doomed.Contains(m.BackupId)))
        {
            await destination.DeleteAsync(manifest, cancellationToken);
        }

        return doomed.Count;
    }

    private async Task TryFinishAsync(Guid runId, CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var run = await db.BackupRuns.SingleOrDefaultAsync(r => r.Id == runId, cancellationToken);
        if (run is not { State: BackupRunState.Running })
        {
            return;
        }

        var targets = await db.BackupRunTargets.Where(t => t.RunId == runId).ToListAsync(cancellationToken);
        if (targets.Any(t => t.State is BackupTargetState.Pending or BackupTargetState.Uploading))
        {
            return;
        }

        var succeeded = targets.Count(t => t.State == BackupTargetState.Succeeded);
        run.State = targets.Count == 0 || succeeded == targets.Count
            ? BackupRunState.Succeeded
            : succeeded == 0 && !run.KeepForDownload ? BackupRunState.Failed : BackupRunState.PartlyFailed;
        run.FinishedAt = Now;
        run.Error ??= run.State == BackupRunState.Succeeded ? null : "Not every destination took the backup.";
        await db.SaveChangesAsync(cancellationToken);

        var file = RunFile(runId);
        if (run.KeepForDownload && File.Exists(file))
        {
            downloads.Adopt(runId, file);
        }
        else
        {
            BackupArchive.TryDelete(file);
        }

        await audit.AppendAsync(
            new AuditEntry(
                "backup.run",
                run.State == BackupRunState.Succeeded ? AuditResult.Success : AuditResult.Failed,
                Target: runId.ToString("D"),
                Parameters: new Dictionary<string, string?>
                {
                    ["state"] = run.State.ToString(),
                    ["sizeBytes"] = run.SizeBytes?.ToString(CultureInfo.InvariantCulture),
                    ["sha256"] = run.Sha256,
                }),
            cancellationToken);

        var refusedBy = targets.Where(t => t.State == BackupTargetState.Failed).Select(t => $"{t.DestinationName}: {t.Error ?? "failed"}");
        await AlertAsync(run.PlanId, run.PlanName, run.State, string.Join(" ", [run.Error, .. refusedBy]));
    }

    /// <summary>One alert per plan, and one for runs made by hand without a plan.</summary>
    private async Task AlertAsync(Guid? planId, string? planName, BackupRunState state, string? message)
    {
        var resource = planId is Guid id ? $"backup-plan:{id:D}" : "backup:manual";
        if (state == BackupRunState.Succeeded)
        {
            await alerts.ResolveAsync(AlertKind.BackupFailed, resource, CancellationToken.None);
            return;
        }

        var severity = state == BackupRunState.Failed ? AlertSeverity.Critical : AlertSeverity.Warning;
        await alerts.RaiseAsync(AlertKind.BackupFailed, resource, severity, $"{planName ?? "A backup made by hand"}: {message}", CancellationToken.None);
    }

    private string RunFile(Guid runId) => Path.Combine(Folder, runId.ToString("N") + BackupNaming.Extension);

    private void EnsureFolder()
    {
        if (OperatingSystem.IsWindows())
        {
            Directory.CreateDirectory(Folder);
            return;
        }

        Directory.CreateDirectory(Folder, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
    }

    private static string Trim(string message) => message.Length > 1000 ? message[..1000] : message;
}
