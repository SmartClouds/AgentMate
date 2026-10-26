using Hangfire;
using Hangfire.Storage.SQLite;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using Runova.ServerCore.Alerts;
using Runova.ServerCore.Audit;
using Runova.ServerCore.Backups;
using Runova.ServerCore.Backups.Destinations;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Hosting;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Tests.Backups;

/// <summary>
/// A backup run end to end (E28): made once, encrypted to the key ring, sent to each destination
/// as its own job with its own retries, pruned per plan, and kept in the history. One destination
/// failing never holds up the others, and nothing a plan did not make is ever deleted.
/// </summary>
public sealed class BackupRunnerTests : IAsyncLifetime
{
    private const string Secret = "violet harbour engine kettle";

    private readonly FakeTimeProvider _clock = new(DateTimeOffset.Parse("2026-10-22T03:00:00Z", System.Globalization.CultureInfo.InvariantCulture));
    private readonly FakeDestinations _destinations = new();
    private readonly FakeBackupDocker _docker = new();
    private TestDatabase _database = null!;
    private SQLiteStorage _hangfire = null!;
    private BackupCenter _center = null!;
    private BackupRunner _runner = null!;
    private InlineBackupQueue _queue = null!;
    private BackupService _downloads = null!;
    private AlertCenter _alerts = null!;

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        _database = await TestDatabase.CreateAsync();
        _hangfire = new SQLiteStorage(Path.Combine(_database.Directory, "hangfire.db"), new SQLiteStorageOptions());
        var scheduler = new BackupPlanScheduler(new RecurringJobManager(_hangfire), _hangfire);
        _center = new BackupCenter(_database.Contexts, new EphemeralDataProtectionProvider(), scheduler, _clock);
        var directories = new CoreDirectories(_database.Directory);
        var composer = new FullBackupComposer(directories, _docker, new FakeServerState(), new FullBackupOptions(Path.Combine(_database.Directory, "none.json"), "web-1", _ => long.MaxValue));
        _downloads = new BackupService(directories, _clock);
        _queue = new InlineBackupQueue();
        _alerts = new AlertCenter(_database.Contexts, _clock, new Redactor(), NullLogger<AlertCenter>.Instance);
        _runner = new BackupRunner(_database.Contexts, _center, composer, _destinations, _queue, new AuditLog(_database.Contexts, _clock, new Redactor()), directories, _downloads, _alerts, new BackupRunGate(), _clock);
        _queue.Runner = _runner;
        await _center.SetSecretAsync(new SetBackupSecretRequest(null, Secret), Cancel);
        _docker.AddVolume("shop_db", new() { ["base.sql"] = "insert into orders"u8.ToArray() }, project: "shop");
    }

    public async ValueTask DisposeAsync()
    {
        _downloads.Dispose();
        _alerts.Dispose();
        _hangfire.Dispose();
        await _database.DisposeAsync();
    }

    private async Task<BackupDestinationInfo> DestinationAsync(string name, long? maxPartBytes = null) =>
        await _center.SaveDestinationAsync(
            new SaveBackupDestinationRequest(null, name, BackupDestinationKind.Folder, new BackupDestinationSettings(Path: "/srv/" + name), null, maxPartBytes),
            null,
            Cancel);

    private async Task<BackupPlanInfo> PlanAsync(int keep, params Guid[] destinations) =>
        await _center.SavePlanAsync(new SaveBackupPlanRequest(null, "Nightly", true, "0 3 * * *", "UTC", keep, null, destinations), Cancel);

    private async Task<BackupRunInfo> RunPlanAsync(BackupPlanInfo plan)
    {
        _clock.Advance(TimeSpan.FromDays(1));
        await _runner.RunPlanAsync(plan.Id, Cancel);
        return (await _center.ListRunsAsync(1, Cancel))[0];
    }

    private static async Task<byte[]> RestoreAsync(InMemoryBackupDestination store, BackupManifestFile manifest)
    {
        var joined = new MemoryStream();
        await BackupParts.JoinAsync(manifest.Parts, (part, token) => store.OpenPartAsync(manifest, part, token), joined, Cancel);
        joined.Position = 0;
        var plain = new MemoryStream();
        await BackupCrypto.DecryptAsync(joined, plain, Secret, Cancel);
        return plain.ToArray();
    }

    [Fact]
    public async Task A_plan_s_run_lands_on_every_destination_and_opens_with_the_secret()
    {
        var first = await DestinationAsync("first");
        var second = await DestinationAsync("second");
        var plan = await PlanAsync(7, first.Id, second.Id);

        var run = await RunPlanAsync(plan);

        Assert.Equal(BackupRunState.Succeeded, run.State);
        Assert.Equal(BackupTrigger.Schedule, run.Trigger);
        Assert.All(run.Targets, target => Assert.Equal(BackupTargetState.Succeeded, target.State));
        foreach (var id in new[] { first.Id, second.Id })
        {
            var manifest = Assert.Single(await _destinations[id].ListAsync(Cancel));
            Assert.Equal(run.Id, manifest.BackupId);
            Assert.Equal(plan.Id, manifest.PlanId);
            Assert.Equal("web-1", manifest.ServerName);
            Assert.True((await RestoreAsync(_destinations[id], manifest)).Length > 0);
        }

        Assert.Empty(Directory.EnumerateFiles(Path.Combine(_database.Directory, BackupRunner.RunsFolder)));
    }

    [Fact]
    public async Task One_destination_failing_does_not_hold_up_the_others()
    {
        var good = await DestinationAsync("good");
        var bad = await DestinationAsync("bad");
        _destinations[bad.Id].RefuseWith = "The FTP server cannot be reached.";
        var plan = await PlanAsync(7, good.Id, bad.Id);

        var run = await RunPlanAsync(plan);

        Assert.Equal(BackupRunState.PartlyFailed, run.State);
        var failed = Assert.Single(run.Targets, target => target.DestinationId == bad.Id);
        Assert.Equal(BackupTargetState.Failed, failed.State);
        Assert.Equal(BackupRunner.MaxAttempts, failed.Attempts);
        Assert.Equal("The FTP server cannot be reached.", failed.Error);
        Assert.Single(await _destinations[good.Id].ListAsync(Cancel));
        Assert.Equal(failed.Error, (await _center.ListDestinationsAsync(Cancel)).Single(d => d.Id == bad.Id).LastError);
    }

    [Fact]
    public async Task Each_destination_keeps_the_plan_s_newest_and_nothing_else_is_touched()
    {
        var destination = await DestinationAsync("offsite");
        var plan = await PlanAsync(2, destination.Id);
        var manual = new BackupManifestFile(BackupManifestFile.SchemaVersion, Guid.NewGuid(), null, "web-1", 1, 1, new string('a', 64), "1", "k", [new(1, "runova-web-1-manual.ambackup", 1, new string('a', 64))]);
        _destinations[destination.Id].Put("runova-web-1-manual.manifest.json", System.Text.Encoding.UTF8.GetBytes(manual.ToJson()));

        await RunPlanAsync(plan);
        await RunPlanAsync(plan);
        var third = await RunPlanAsync(plan);

        var held = await _destinations[destination.Id].ListAsync(Cancel);
        Assert.Equal(3, held.Count);
        Assert.Contains(held, m => m.BackupId == manual.BackupId);
        Assert.Equal(2, held.Count(m => m.PlanId == plan.Id));
        Assert.Contains(held, m => m.BackupId == third.Id);
        Assert.Equal(1, Assert.Single(third.Targets).Pruned);
    }

    [Fact]
    public async Task Parts_follow_the_destination_s_size_and_join_back()
    {
        _docker.AddVolume("big", new() { ["blob"] = System.Security.Cryptography.RandomNumberGenerator.GetBytes(3 * 1024 * 1024) });
        var destination = await DestinationAsync("parts", maxPartBytes: 1024 * 1024);
        var plan = await PlanAsync(3, destination.Id);

        await RunPlanAsync(plan);

        var manifest = Assert.Single(await _destinations[destination.Id].ListAsync(Cancel));
        Assert.True(manifest.Parts.Count >= 3);
        Assert.True((await RestoreAsync(_destinations[destination.Id], manifest)).Length > 3 * 1024 * 1024);
    }

    [Fact]
    public async Task Backing_up_now_for_download_keeps_the_file_an_hour_for_the_app()
    {
        var started = await _runner.StartAsync(null, [], keepForDownload: true, Guid.NewGuid(), "maria", Cancel);
        var run = (await _center.ListRunsAsync(1, Cancel))[0];

        Assert.Equal(BackupTrigger.Manual, started.Trigger);
        Assert.Equal(BackupRunState.Succeeded, run.State);
        Assert.Equal("maria", run.RequestedByName);
        await using var file = _downloads.OpenRead(run.Id);
        Assert.NotNull(file);
        Assert.Equal(run.SizeBytes, file.Length);
    }

    [Fact]
    public async Task Nothing_runs_without_a_secret_or_somewhere_to_send_it()
    {
        var refused = await Assert.ThrowsAsync<BackupRefusedException>(() => _runner.StartAsync(null, [], keepForDownload: false, null, null, Cancel));
        await using var db = await _database.Contexts.CreateDbContextAsync(Cancel);
        await db.BackupKeyRing.ExecuteDeleteAsync(Cancel);
        var destination = await DestinationAsync("somewhere");
        var noSecret = await Assert.ThrowsAsync<BackupRefusedException>(() => _runner.StartAsync(null, [destination.Id], keepForDownload: false, null, null, Cancel));

        Assert.Contains("destination", refused.Message, StringComparison.Ordinal);
        Assert.Contains("secret key", noSecret.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_destination_removed_after_the_run_started_fails_on_its_own()
    {
        var kept = await DestinationAsync("kept");
        var removed = await DestinationAsync("removed");
        _queue.BeforeUploads = () => _center.DeleteDestinationAsync(removed.Id, Cancel);
        var plan = await PlanAsync(3, kept.Id, removed.Id);

        var run = await RunPlanAsync(plan);

        Assert.Equal(BackupRunState.PartlyFailed, run.State);
        Assert.Contains("removed", run.Targets.Single(t => t.DestinationId == removed.Id).Error, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_backup_that_cannot_be_made_raises_a_critical_alert_for_its_plan()
    {
        var destination = await DestinationAsync("offsite");
        var plan = await PlanAsync(3, destination.Id);
        _docker.FailVolume = "shop_db";

        var run = await RunPlanAsync(plan);

        Assert.Equal(BackupRunState.Failed, run.State);
        var alert = Assert.Single(await _alerts.OpenAsync(AlertKind.BackupFailed, Cancel));
        Assert.Equal($"backup-plan:{plan.Id:D}", alert.Resource);
        Assert.Equal(AlertSeverity.Critical, alert.Severity);
        Assert.StartsWith("Nightly: ", alert.Message, StringComparison.Ordinal);
        Assert.Contains("shop_db", alert.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_destination_that_did_not_take_it_raises_a_warning_that_names_it()
    {
        var good = await DestinationAsync("good");
        var bad = await DestinationAsync("bad");
        _destinations[bad.Id].RefuseWith = "The FTP server cannot be reached.";
        var plan = await PlanAsync(7, good.Id, bad.Id);

        await RunPlanAsync(plan);

        var alert = Assert.Single(await _alerts.OpenAsync(AlertKind.BackupFailed, Cancel));
        Assert.Equal(AlertSeverity.Warning, alert.Severity);
        Assert.Contains("bad: The FTP server cannot be reached.", alert.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("good", alert.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_next_run_of_the_plan_that_works_resolves_the_alert()
    {
        var destination = await DestinationAsync("offsite");
        var plan = await PlanAsync(3, destination.Id);
        _docker.FailVolume = "shop_db";
        await RunPlanAsync(plan);

        _docker.FailVolume = null;
        var run = await RunPlanAsync(plan);

        Assert.Equal(BackupRunState.Succeeded, run.State);
        Assert.Empty(await _alerts.OpenAsync(AlertKind.BackupFailed, Cancel));
        Assert.NotNull(Assert.Single(await _alerts.ListAsync(new AlertQuery(IncludeResolved: true), Cancel)).ResolvedAtUnixMs);
    }

    [Fact]
    public async Task A_scheduled_run_refused_before_it_starts_raises_an_alert_too()
    {
        var destination = await DestinationAsync("offsite");
        var plan = await PlanAsync(3, destination.Id);
        await using (var db = await _database.Contexts.CreateDbContextAsync(Cancel))
        {
            await db.BackupKeyRing.ExecuteDeleteAsync(Cancel);
        }

        _clock.Advance(TimeSpan.FromDays(1));
        await _runner.RunPlanAsync(plan.Id, Cancel);

        var alert = Assert.Single(await _alerts.OpenAsync(AlertKind.BackupFailed, Cancel));
        Assert.Equal(AlertSeverity.Critical, alert.Severity);
        Assert.Contains("secret key", alert.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Every_run_is_audited_without_the_secret()
    {
        var destination = await DestinationAsync("audited");
        await RunPlanAsync(await PlanAsync(3, destination.Id));

        await using var db = await _database.Contexts.CreateDbContextAsync(Cancel);
        var audit = await db.AuditEvents.OrderBy(e => e.Id).ToListAsync(Cancel);
        Assert.Contains(audit, e => e.Action == "backup.run" && e.Result == AuditResult.Success);
        Assert.Contains(audit, e => e.Action == "backup.upload" && e.Result == AuditResult.Success);
        Assert.DoesNotContain(audit, e => e.Parameters?.Contains("violet", StringComparison.Ordinal) == true);
    }

    [Fact]
    public async Task A_full_backup_stages_on_a_new_server_with_the_secret_alone()
    {
        var run = await _runner.StartAsync(null, [], keepForDownload: true, null, "maria", Cancel);
        var newServer = Path.Combine(Path.GetTempPath(), $"core-new-{Guid.NewGuid():N}");
        var into = Path.Combine(Path.GetTempPath(), $"core-staged-{Guid.NewGuid():N}");
        try
        {
            using var input = new StringReader(Secret + "\n");
            using var output = new StringWriter();
            using var error = new StringWriter();
            var code = await Runova.ServerCore.Cli.AdminCli.RunAsync(
                ["restore-stage", "--file", _downloads.PathFor(run.Id), "--into", into, "--passphrase-stdin"],
                input,
                output,
                error,
                () => new Runova.ServerCore.Cli.AdminEnvironment(newServer, TimeProvider.System, 1000, "deployer"));

            Assert.True(code == 0, error.ToString());
            Assert.True(File.Exists(Path.Combine(into, "server", "server.json")));
            Assert.True(File.Exists(Path.Combine(into, "server", "volumes", "shop_db.tar")));
            Assert.Contains("web-1", output.ToString(), StringComparison.Ordinal);
        }
        finally
        {
            Data.CoreDatabase.ReleasePool(Data.CoreDatabase.PathIn(into));
            Data.CoreDatabase.ReleasePool(Data.CoreDatabase.PathIn(newServer));
            TestFolders.Delete(into);
            TestFolders.Delete(newServer);
        }
    }

    /// <summary>Runs queued work at once, retrying an upload the way Hangfire would.</summary>
    private sealed class InlineBackupQueue : IBackupJobQueue
    {
        private readonly List<(Guid Run, Guid Destination)> _uploads = [];

        public BackupRunner Runner { get; set; } = null!;

        public Func<Task<bool>>? BeforeUploads { get; set; }

        public void EnqueueRun(Guid runId) => Runner.RunAsync(runId, Cancel).GetAwaiter().GetResult();

        public void EnqueueUpload(Guid runId, Guid destinationId)
        {
            if (BeforeUploads is { } before)
            {
                BeforeUploads = null;
                before().GetAwaiter().GetResult();
            }

            _uploads.Add((runId, destinationId));
            for (var attempt = 1; ; attempt++)
            {
                try
                {
                    Runner.UploadAsync(runId, destinationId, Cancel).GetAwaiter().GetResult();
                    return;
                }
                catch (BackupDestinationException) when (attempt < BackupRunner.MaxAttempts)
                {
                }
            }
        }
    }
}
