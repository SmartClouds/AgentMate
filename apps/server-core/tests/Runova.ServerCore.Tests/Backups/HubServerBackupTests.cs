using System.Text.Json;
using Hangfire;
using Hangfire.Storage;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Runova.ServerCore.Audit;
using Runova.ServerCore.Backups;
using Runova.ServerCore.Backups.Destinations;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Tests.Backups;

/// <summary>
/// The server backups hub (E28): Owners only; a step-up for the secret and for credentials. The
/// secret is never kept or echoed, credentials are sealed and never read back, and a plan is a
/// Hangfire recurring job the moment it is saved.
/// </summary>
public sealed class HubServerBackupTests
{
    private const string Secret = "violet harbour engine kettle";
    private const string FtpPassword = "ftp-password-never-shown";

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private static async Task<(AuthHarness Harness, HubConnection Hub)> ConnectAsync(string role = CoreRoles.Owner, bool stepUp = true, FakeDestinations? destinations = null)
    {
        var harness = await AuthHarness.CreateAsync(
            role,
            fakeClock: false,
            services: (services, _) =>
            {
                services.AddSingleton(new BackupJobServerOptions(RunInBackground: true));
                if (destinations is not null)
                {
                    services.AddSingleton<IBackupDestinationFactory>(destinations);
                    services.AddSingleton<IBackupDocker>(new FakeBackupDocker());
                    services.AddSingleton<IServerStateReader>(new FakeServerState());
                    services.AddSingleton<ITelegramConnector>(new FakeTelegramConnector(password: "cloud pw"));
                }
            });
        var signedIn = await harness.SignInAsync();
        var hub = harness.Hub(signedIn.AccessToken);
        await hub.StartAsync(Cancel);
        if (stepUp)
        {
            await hub.InvokeAsync<StepUpResponse>(nameof(ICoreHub.StepUp), new StepUpRequest(AuthHarness.Password), Cancel);
        }

        return (harness, hub);
    }

    private static Task<T> CallAsync<T>(HubConnection hub, string method, params object?[] args) =>
        hub.InvokeCoreAsync<T>(method, args, Cancel);

    private static async Task<List<(string Action, string Result, string? Parameters)>> AuditAsync(AuthHarness harness)
    {
        await using var scope = harness.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<CoreDbContext>();
        return [.. (await db.AuditEvents.OrderBy(e => e.Id).ToListAsync(Cancel)).Select(e => (e.Action, e.Result, e.Parameters))];
    }

    private static SaveBackupDestinationRequest Folder(string name = "On this server") =>
        new(null, name, BackupDestinationKind.Folder, new BackupDestinationSettings(Path: "/var/backups/runova"), null, null);

    private static SaveBackupDestinationRequest Ftp() =>
        new(
            null,
            "Offsite FTP",
            BackupDestinationKind.Ftp,
            new BackupDestinationSettings(Path: "/backups", Host: "backup.example.com", Port: 21, UserName: "deploy", Tls: true),
            new BackupDestinationSecret(Password: FtpPassword),
            null);

    private static SaveBackupPlanRequest Plan(Guid destination, string cron = "0 3 * * *") =>
        new(null, "Nightly", true, cron, "UTC", 7, null, [destination]);

    [Fact]
    public async Task Below_owner_nothing_is_shown_and_credentials_need_a_step_up()
    {
        var (admin, adminHub) = await ConnectAsync(CoreRoles.Admin);
        await using (admin)
        await using (adminHub)
        {
            var refused = await Assert.ThrowsAsync<HubException>(() => CallAsync<BackupDestinationInfo[]>(adminHub, nameof(ICoreHub.ListBackupDestinations)));
            Assert.Contains("unauthorized", refused.Message, StringComparison.OrdinalIgnoreCase);
        }

        var (owner, ownerHub) = await ConnectAsync(stepUp: false);
        await using (owner)
        await using (ownerHub)
        {
            Assert.Empty(await CallAsync<BackupDestinationInfo[]>(ownerHub, nameof(ICoreHub.ListBackupDestinations)));
            await Assert.ThrowsAsync<HubException>(() => CallAsync<BackupDestinationInfo>(ownerHub, nameof(ICoreHub.SaveBackupDestination), Ftp()));
            await Assert.ThrowsAsync<HubException>(() => CallAsync<BackupSecretStatus>(ownerHub, nameof(ICoreHub.SetBackupSecret), new SetBackupSecretRequest(null, Secret)));
        }
    }

    [Fact]
    public async Task The_secret_is_set_once_changed_only_with_the_current_one_and_never_kept()
    {
        var (harness, hub) = await ConnectAsync();
        await using (harness)
        await using (hub)
        {
            Assert.False((await CallAsync<BackupSecretStatus>(hub, nameof(ICoreHub.GetBackupSecret))).IsSet);

            var set = await CallAsync<BackupSecretStatus>(hub, nameof(ICoreHub.SetBackupSecret), new SetBackupSecretRequest(null, Secret));
            var again = await Assert.ThrowsAsync<HubException>(() =>
                CallAsync<BackupSecretStatus>(hub, nameof(ICoreHub.SetBackupSecret), new SetBackupSecretRequest(null, "a different secret key")));
            var wrong = await Assert.ThrowsAsync<HubException>(() =>
                CallAsync<BackupSecretStatus>(hub, nameof(ICoreHub.SetBackupSecret), new SetBackupSecretRequest("not the secret at all", "a different secret key")));
            var changed = await CallAsync<BackupSecretStatus>(hub, nameof(ICoreHub.SetBackupSecret), new SetBackupSecretRequest(Secret, "a different secret key"));

            Assert.True(set.IsSet);
            Assert.Equal(set.KeyId, changed.KeyId);
            Assert.Contains("current secret", again.Message, StringComparison.Ordinal);
            Assert.Contains("secret key is wrong", wrong.Message, StringComparison.Ordinal);

            await using var scope = harness.Services.CreateAsyncScope();
            var ring = await scope.ServiceProvider.GetRequiredService<CoreDbContext>().BackupKeyRing.SingleAsync(Cancel);
            Assert.DoesNotContain(Secret, JsonSerializer.Serialize(ring), StringComparison.Ordinal);
            var audit = await AuditAsync(harness);
            Assert.Contains(audit, entry => entry.Action == "backup.secret.set" && entry.Result == AuditResult.Success);
            Assert.DoesNotContain(audit, entry => entry.Parameters?.Contains("violet", StringComparison.Ordinal) == true);
        }
    }

    [Fact]
    public async Task Destinations_are_kept_with_their_credentials_sealed_and_never_read_back()
    {
        var (harness, hub) = await ConnectAsync();
        await using (harness)
        await using (hub)
        {
            var ftp = await CallAsync<BackupDestinationInfo>(hub, nameof(ICoreHub.SaveBackupDestination), Ftp());
            var folder = await CallAsync<BackupDestinationInfo>(hub, nameof(ICoreHub.SaveBackupDestination), Folder());
            var listed = await CallAsync<BackupDestinationInfo[]>(hub, nameof(ICoreHub.ListBackupDestinations));
            var renamed = await CallAsync<BackupDestinationInfo>(
                hub,
                nameof(ICoreHub.SaveBackupDestination),
                Ftp() with { Id = ftp.Id, Name = "Offsite", Secret = null });
            var invalid = await Assert.ThrowsAsync<HubException>(() =>
                CallAsync<BackupDestinationInfo>(hub, nameof(ICoreHub.SaveBackupDestination), Folder("Bad") with { Settings = new(Path: "/etc/x") }));
            var duplicate = await Assert.ThrowsAsync<HubException>(() =>
                CallAsync<BackupDestinationInfo>(hub, nameof(ICoreHub.SaveBackupDestination), Folder()));

            Assert.True(ftp.HasSecret);
            Assert.False(folder.HasSecret);
            Assert.Equal("ftps://deploy@backup.example.com:21/backups", ftp.Summary);
            Assert.Equal(["Offsite FTP", "On this server"], listed.Select(d => d.Name).Order());
            Assert.True(renamed.HasSecret);
            Assert.Equal("Offsite", renamed.Name);
            Assert.Contains("system folder", invalid.Message, StringComparison.Ordinal);
            Assert.Contains("already", duplicate.Message, StringComparison.Ordinal);
            Assert.DoesNotContain(FtpPassword, JsonSerializer.Serialize(listed), StringComparison.Ordinal);

            await using var scope = harness.Services.CreateAsyncScope();
            var stored = await scope.ServiceProvider.GetRequiredService<CoreDbContext>().BackupDestinations.SingleAsync(d => d.Id == ftp.Id, Cancel);
            Assert.NotNull(stored.ProtectedSecret);
            Assert.DoesNotContain(FtpPassword, stored.ProtectedSecret, StringComparison.Ordinal);
            var unsealed = await scope.ServiceProvider.GetRequiredService<BackupCenter>().OpenDestinationAsync(ftp.Id, Cancel);
            Assert.Equal(FtpPassword, unsealed!.Secret.Password);
            Assert.DoesNotContain(await AuditAsync(harness), entry => entry.Parameters?.Contains(FtpPassword, StringComparison.Ordinal) == true);
        }
    }

    [Fact]
    public async Task A_plan_is_on_the_schedule_once_saved_and_off_it_once_deleted()
    {
        var (harness, hub) = await ConnectAsync();
        await using (harness)
        await using (hub)
        {
            var folder = await CallAsync<BackupDestinationInfo>(hub, nameof(ICoreHub.SaveBackupDestination), Folder());
            var plan = await CallAsync<BackupPlanInfo>(hub, nameof(ICoreHub.SaveBackupPlan), Plan(folder.Id));

            Assert.NotNull(plan.NextRunAtUnixMs);
            Assert.Equal([folder.Id], plan.DestinationIds);
            Assert.Contains(RecurringIds(harness), id => id == BackupPlanScheduler.RecurringId(plan.Id));

            var tooOften = await Assert.ThrowsAsync<HubException>(() => CallAsync<BackupPlanInfo>(hub, nameof(ICoreHub.SaveBackupPlan), Plan(folder.Id, "*/5 * * * *") with { Name = "Busy" }));
            var nowhere = await Assert.ThrowsAsync<HubException>(() => CallAsync<BackupPlanInfo>(hub, nameof(ICoreHub.SaveBackupPlan), Plan(Guid.NewGuid()) with { Name = "Lost" }));
            Assert.Contains("15 minutes", tooOften.Message, StringComparison.Ordinal);
            Assert.Contains("destination", nowhere.Message, StringComparison.Ordinal);

            Assert.True(await CallAsync<bool>(hub, nameof(ICoreHub.DeleteBackupPlan), plan.Id));
            Assert.DoesNotContain(RecurringIds(harness), id => id == BackupPlanScheduler.RecurringId(plan.Id));
            Assert.Empty(await CallAsync<BackupPlanInfo[]>(hub, nameof(ICoreHub.ListBackupPlans)));
        }
    }

    [Fact]
    public async Task Removing_a_destination_takes_it_out_of_its_plans()
    {
        var (harness, hub) = await ConnectAsync();
        await using (harness)
        await using (hub)
        {
            var first = await CallAsync<BackupDestinationInfo>(hub, nameof(ICoreHub.SaveBackupDestination), Folder("First"));
            var second = await CallAsync<BackupDestinationInfo>(hub, nameof(ICoreHub.SaveBackupDestination), Folder("Second") with { Settings = new(Path: "/srv/backups") });
            await CallAsync<BackupPlanInfo>(hub, nameof(ICoreHub.SaveBackupPlan), Plan(first.Id) with { DestinationIds = [first.Id, second.Id] });

            Assert.True(await CallAsync<bool>(hub, nameof(ICoreHub.DeleteBackupDestination), first.Id));

            var plan = Assert.Single(await CallAsync<BackupPlanInfo[]>(hub, nameof(ICoreHub.ListBackupPlans)));
            Assert.Equal([second.Id], plan.DestinationIds);
        }
    }

    [Fact]
    public async Task The_preview_says_how_many_stay_and_explains_a_schedule_that_will_not_do()
    {
        var (harness, hub) = await ConnectAsync();
        await using (harness)
        await using (hub)
        {
            var preview = await CallAsync<BackupPlanPreview>(hub, nameof(ICoreHub.PreviewBackupPlan), new BackupPlanPreviewRequest(null, "0 3 * * *", "UTC", 7, null));
            var broken = await CallAsync<BackupPlanPreview>(hub, nameof(ICoreHub.PreviewBackupPlan), new BackupPlanPreviewRequest(null, "nope", "UTC", 7, null));

            Assert.Null(preview.Problem);
            Assert.Equal(7, preview.Kept);
            Assert.Equal(5, preview.NextRunsUnixMs.Length);
            Assert.Equal(6L * 86_400_000, preview.CoversMs);
            Assert.Null(preview.BytesPerDestination);
            Assert.NotNull(broken.Problem);
            Assert.Empty(await CallAsync<BackupRunInfo[]>(hub, nameof(ICoreHub.ListBackupRuns), 20));
        }
    }

    [Fact]
    public async Task A_destination_is_tested_before_and_after_it_is_saved_and_the_outcome_is_kept()
    {
        var destinations = new FakeDestinations();
        var (harness, hub) = await ConnectAsync(destinations: destinations);
        await using (harness)
        await using (hub)
        {
            var draft = await CallAsync<BackupDestinationTest>(hub, nameof(ICoreHub.TestBackupDestination), Ftp());
            var saved = await CallAsync<BackupDestinationInfo>(hub, nameof(ICoreHub.SaveBackupDestination), Ftp());
            destinations[saved.Id].RefuseWith = "The FTP server refused the user name or password.";
            var failing = await CallAsync<BackupDestinationTest>(hub, nameof(ICoreHub.TestBackupDestination), Ftp() with { Id = saved.Id, Secret = null });
            var incomplete = await CallAsync<BackupDestinationTest>(hub, nameof(ICoreHub.TestBackupDestination), Ftp() with { Settings = new(Host: "backup.example.com") });

            Assert.True(draft.Ok);
            Assert.False(failing.Ok);
            Assert.Equal("The FTP server refused the user name or password.", failing.Problem);
            Assert.Equal(FtpPassword, destinations.Opened[^1].Secret.Password);
            Assert.False(incomplete.Ok);
            Assert.Contains("user name", incomplete.Problem, StringComparison.Ordinal);
            var listed = Assert.Single(await CallAsync<BackupDestinationInfo[]>(hub, nameof(ICoreHub.ListBackupDestinations)));
            Assert.Equal(failing.Problem, listed.LastError);
            Assert.NotNull(listed.LastTestedAtUnixMs);
        }
    }

    [Fact]
    public async Task Backing_up_now_runs_on_hangfire_and_the_file_downloads_once()
    {
        var destinations = new FakeDestinations();
        var (harness, hub) = await ConnectAsync(destinations: destinations);
        await using (harness)
        await using (hub)
        {
            var noSecret = await Assert.ThrowsAsync<HubException>(() =>
                CallAsync<BackupRunInfo>(hub, nameof(ICoreHub.RunBackupNow), new RunBackupNowRequest([], true)));
            await CallAsync<BackupSecretStatus>(hub, nameof(ICoreHub.SetBackupSecret), new SetBackupSecretRequest(null, Secret));
            var folder = await CallAsync<BackupDestinationInfo>(hub, nameof(ICoreHub.SaveBackupDestination), Folder());

            var started = await CallAsync<BackupRunInfo>(hub, nameof(ICoreHub.RunBackupNow), new RunBackupNowRequest([folder.Id], true));
            var run = started;
            for (var wait = 0; wait < 120 && run.State == BackupRunState.Running; wait++)
            {
                await Task.Delay(500, Cancel);
                run = (await CallAsync<BackupRunInfo?>(hub, nameof(ICoreHub.GetBackupRun), started.Id))!;
            }

            Assert.Contains("secret key", noSecret.Message, StringComparison.Ordinal);
            // It failed on the shared CI machine a few times, Running after a minute; say what Hangfire was doing.
            Assert.True(run.State == BackupRunState.Succeeded, $"{JsonSerializer.Serialize(run)} {HangfireState(harness)}");
            Assert.Equal("maria", run.RequestedByName);
            var stored = Assert.Single(await CallAsync<StoredBackupInfo[]>(hub, nameof(ICoreHub.ListStoredBackups), folder.Id));
            Assert.Equal(run.Id, stored.BackupId);

            var token = (await harness.SignInAsync()).AccessToken;
            using var request = new HttpRequestMessage(HttpMethod.Get, $"/api/v1/backups/{run.Id:D}");
            request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
            using var response = await harness.Client.SendAsync(request, Cancel);
            var bytes = await response.Content.ReadAsByteArrayAsync(Cancel);
            Assert.Equal(System.Net.HttpStatusCode.OK, response.StatusCode);
            Assert.True(bytes.AsSpan(0, 8).SequenceEqual("AMBACKUP"u8));
            Assert.Equal(run.SizeBytes, bytes.Length);

            Assert.True(await CallAsync<bool>(hub, nameof(ICoreHub.DeleteStoredBackup), folder.Id, run.Id));
            Assert.Empty(await CallAsync<StoredBackupInfo[]>(hub, nameof(ICoreHub.ListStoredBackups), folder.Id));
        }
    }

    [Fact]
    public async Task Hangfire_builds_a_cores_jobs_from_that_cores_services_when_another_core_started_later()
    {
        // Hangfire's default activator is a process-wide static the last core to configure it owns.
        // On CI a backup job took a core's provider that was already disposed and failed with it.
        await using var first = await AuthHarness.CreateAsync();
        await using var second = await AuthHarness.CreateAsync();
        _ = second.Services.GetRequiredService<IGlobalConfiguration>();

        using var scope = first.Services.GetRequiredService<JobActivator>().BeginScope((JobActivatorContext)null!);

        Assert.Same(first.Services.GetRequiredService<BackupRunGate>(), scope.Resolve(typeof(BackupRunGate)));
    }

    [Fact]
    public async Task A_telegram_account_signed_in_through_the_hub_becomes_a_destination_with_its_session_sealed()
    {
        var destinations = new FakeDestinations();
        var (harness, hub) = await ConnectAsync(destinations: destinations);
        await using (harness)
        await using (hub)
        {
            var apiHash = new string('b', 32);
            var code = await CallAsync<TelegramLoginState>(hub, nameof(ICoreHub.StartTelegramLogin), new StartTelegramLoginRequest(123456, apiHash, "+15550100"));
            var password = await CallAsync<TelegramLoginState>(hub, nameof(ICoreHub.ContinueTelegramLogin), new ContinueTelegramLoginRequest(code.LoginId, "12345", null));
            var done = await CallAsync<TelegramLoginState>(hub, nameof(ICoreHub.ContinueTelegramLogin), new ContinueTelegramLoginRequest(code.LoginId, null, "cloud pw"));
            var request = new SaveBackupDestinationRequest(
                null,
                "Telegram",
                BackupDestinationKind.Telegram,
                new BackupDestinationSettings(ApiId: 123456, Chat: "me"),
                new BackupDestinationSecret(ApiHash: apiHash, TelegramLoginId: code.LoginId),
                null);
            var saved = await CallAsync<BackupDestinationInfo>(hub, nameof(ICoreHub.SaveBackupDestination), request);
            var again = await Assert.ThrowsAsync<HubException>(() => CallAsync<BackupDestinationInfo>(hub, nameof(ICoreHub.SaveBackupDestination), request with { Name = "Again" }));

            Assert.Equal((TelegramLoginStep.Password, TelegramLoginStep.Done), (password.Step, done.Step));
            Assert.Equal("Telegram, Saved Messages of Ada Lovelace", saved.Summary);
            Assert.True(saved.Settings.IsPremium);
            Assert.True(saved.HasSecret);
            Assert.Contains("expired", again.Message, StringComparison.Ordinal);
            await using var scope = harness.Services.CreateAsyncScope();
            var opened = await scope.ServiceProvider.GetRequiredService<BackupCenter>().OpenDestinationAsync(saved.Id, Cancel);
            Assert.Equal("session-bytes"u8.ToArray(), Convert.FromBase64String(opened!.TelegramSession!));
            Assert.Equal(BackupDestinationRules.TelegramPremiumPartBytes, opened.PartBytes);
            Assert.Contains(await AuditAsync(harness), entry => entry.Action == "backup.telegram.signin");
        }
    }

    [Fact]
    public async Task Only_a_core_that_runs_backups_starts_hangfire_workers()
    {
        await using var quiet = await AuthHarness.CreateAsync(fakeClock: false);
        var (harness, hub) = await ConnectAsync();
        await using (harness)
        await using (hub)
        {
            var servers = harness.Services.GetRequiredService<JobStorage>().GetMonitoringApi();
            for (var wait = 0; wait < 60 && servers.Servers().Count == 0; wait++)
            {
                await Task.Delay(500, Cancel);
            }

            Assert.Equal(2, Assert.Single(servers.Servers()).WorkersCount);
            Assert.Empty(quiet.Services.GetRequiredService<JobStorage>().GetMonitoringApi().Servers());
        }
    }

    private static string HangfireState(AuthHarness harness)
    {
        var monitor = harness.Services.GetRequiredService<JobStorage>().GetMonitoringApi();
        var servers = string.Join(", ", monitor.Servers().Select(s => $"{s.Name} with {s.WorkersCount} workers, last heartbeat {s.Heartbeat:O}"));
        var queues = string.Join(", ", monitor.Queues().Select(q => $"{q.Name}: {q.Length} waiting, {q.Fetched} fetched"));
        var processing = string.Join(", ", monitor.ProcessingJobs(0, 10).Select(j => $"{j.Key} {j.Value.Job?.Method.Name} since {j.Value.StartedAt:O}"));
        var failed = string.Join(" | ", monitor.FailedJobs(0, 10).Select(j => $"{j.Key} {j.Value.Job?.Method.Name}: {j.Value.ExceptionType} {j.Value.ExceptionMessage}"));
        return $"Hangfire at {DateTime.UtcNow:O}. Servers: [{servers}]. Queues: [{queues}]. Processing: [{processing}]. Failed: [{failed}]. Scheduled: {monitor.ScheduledCount()}. Succeeded: {monitor.SucceededListCount()}.";
    }

    private static List<string> RecurringIds(AuthHarness harness)
    {
        using var connection = harness.Services.GetRequiredService<JobStorage>().GetConnection();
        return [.. connection.GetRecurringJobs().Select(job => job.Id)];
    }
}
