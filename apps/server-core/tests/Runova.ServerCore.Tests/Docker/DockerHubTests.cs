using System.Text.Json;
using System.Threading.Channels;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Docker;
using Runova.ServerCore.Hubs;
using Runova.ServerCore.Jobs;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Tests.Docker;

/// <summary>
/// The Docker side of the hub through a real connection, on the pretend engine: grouping, the
/// environment kept out of everything but the reveal (Admin, after a step-up), lifecycle by
/// Operators with every change and refusal recorded, stats, logs and events streams, consoles,
/// pulls, prunes and the install job.
/// </summary>
public sealed class DockerHubTests
{
    private const string Web = "shop-web-1";

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private static async Task<HubConnection> ConnectAsync(AuthHarness harness)
    {
        var signedIn = await harness.SignInAsync();
        var hub = harness.Hub(signedIn.AccessToken);
        await hub.StartAsync(Cancel);
        return hub;
    }

    private static InMemoryDockerEngine Engine(AuthHarness harness) => harness.Services.GetRequiredService<InMemoryDockerEngine>();

    private static async Task<List<(string Action, string Result, string? Target, string? Parameters)>> AuditAsync(AuthHarness harness)
    {
        await using var scope = harness.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<CoreDbContext>();
        return [.. (await db.AuditEvents.OrderBy(e => e.Id).ToListAsync(Cancel)).Select(e => (e.Action, e.Result, e.Target, e.Parameters))];
    }

    private static async Task<List<T>> ReadUntilAsync<T>(IAsyncEnumerator<T> stream, Func<List<T>, bool> done, int seconds = 10)
    {
        var items = new List<T>();
        while (!done(items))
        {
            Assert.True(await stream.MoveNextAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(seconds), Cancel), "The stream ended early.");
            items.Add(stream.Current);
        }

        return items;
    }

    [Fact]
    public async Task A_viewer_sees_containers_grouped_by_compose_project_and_the_engine_status()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Viewer);
        await using var hub = await ConnectAsync(harness);

        var list = await hub.InvokeAsync<ContainerList>(nameof(ICoreHub.ListContainers), Cancel);
        var status = await hub.InvokeAsync<DockerStatus>(nameof(ICoreHub.GetDockerStatus), Cancel);

        Assert.Equal(["monitoring", "shop", null], list.Groups.Select(g => g.Project));
        var shop = list.Groups[1];
        Assert.Equal(["api", "db", "web", "worker"], shop.Containers.Select(c => c.ComposeService));
        Assert.Equal("/srv/apps/shop", shop.WorkingDirectory);
        Assert.Equal(["migrate-once", "toolbox"], list.Groups[2].Containers.Select(c => c.Name).Order(StringComparer.Ordinal));
        Assert.True(status.Running);
        Assert.True(status.ComposeSupported);
        Assert.Equal("2.39.4", status.ComposeVersion);
        Assert.Equal(InMemoryDockerEngine.EngineVersionText, status.EngineVersion);
        Assert.Null(status.Message);
    }

    [Fact]
    public async Task Inspect_names_the_environment_without_a_single_value()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Viewer);
        await using var hub = await ConnectAsync(harness);

        var details = await hub.InvokeAsync<ContainerDetails>(nameof(ICoreHub.InspectContainer), "shop-api-1", Cancel);

        Assert.Equal(["NODE_ENV", "PORT", "DATABASE_URL", "API_TOKEN"], details.EnvKeys);
        var json = JsonSerializer.Serialize(details, CoreJson.Options);
        Assert.DoesNotContain(InMemoryDockerEngine.DatabasePassword, json, StringComparison.Ordinal);
        Assert.DoesNotContain(InMemoryDockerEngine.ApiToken, json, StringComparison.Ordinal);
        Assert.DoesNotContain("production", json, StringComparison.Ordinal);
        Assert.Contains(details.Mounts, mount => mount.Name == "shop_uploads");
    }

    [Fact]
    public async Task Environment_values_are_for_admins_after_a_step_up_and_never_reach_the_audit_trail()
    {
        await using var operatorHarness = await AuthHarness.CreateAsync(CoreRoles.Operator);
        await using var operatorHub = await ConnectAsync(operatorHarness);
        await operatorHub.InvokeAsync<StepUpResponse>(nameof(ICoreHub.StepUp), new StepUpRequest(AuthHarness.Password), Cancel);
        await Assert.ThrowsAsync<HubException>(() => operatorHub.InvokeAsync<ContainerEnvVariable[]>(nameof(ICoreHub.RevealContainerEnv), "shop-db-1", Cancel));

        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Admin);
        await using var hub = await ConnectAsync(harness);
        var refused = await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync<ContainerEnvVariable[]>(nameof(ICoreHub.RevealContainerEnv), "shop-db-1", Cancel));
        await hub.InvokeAsync<StepUpResponse>(nameof(ICoreHub.StepUp), new StepUpRequest(AuthHarness.Password), Cancel);
        var revealed = await hub.InvokeAsync<ContainerEnvVariable[]>(nameof(ICoreHub.RevealContainerEnv), "shop-db-1", Cancel);

        Assert.Contains("unauthorized", refused.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Contains(new ContainerEnvVariable("POSTGRES_PASSWORD", InMemoryDockerEngine.DatabasePassword), revealed);
        var audit = await AuditAsync(harness);
        Assert.Contains(audit, e => e.Action == "container.env-reveal" && e.Result == "success" && e.Target == "shop-db-1");
        Assert.DoesNotContain(audit, e => e.Parameters?.Contains(InMemoryDockerEngine.DatabasePassword, StringComparison.Ordinal) == true);
        Assert.DoesNotContain(audit, e => e.Parameters?.Contains("POSTGRES_PASSWORD", StringComparison.Ordinal) == true);
    }

    [Fact]
    public async Task An_operator_stops_and_starts_a_container_and_each_change_is_recorded()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Operator);
        await using var hub = await ConnectAsync(harness);

        var stopped = await hub.InvokeAsync<ContainerSummary>(nameof(ICoreHub.StopContainer), Web, 5, Cancel);
        var started = await hub.InvokeAsync<ContainerSummary>(nameof(ICoreHub.StartContainer), Web, Cancel);
        var paused = await hub.InvokeAsync<ContainerSummary>(nameof(ICoreHub.PauseContainer), Web, Cancel);
        var unpaused = await hub.InvokeAsync<ContainerSummary>(nameof(ICoreHub.UnpauseContainer), Web, Cancel);
        var restarted = await hub.InvokeAsync<ContainerSummary>(nameof(ICoreHub.RestartContainer), Web, null, Cancel);
        var killed = await hub.InvokeAsync<ContainerSummary>(nameof(ICoreHub.KillContainer), Web, "SIGTERM", Cancel);

        Assert.Equal(ContainerState.Exited, stopped.State);
        Assert.Equal(ContainerState.Running, started.State);
        Assert.Equal(ContainerState.Paused, paused.State);
        Assert.Equal(ContainerState.Running, unpaused.State);
        Assert.Equal(ContainerState.Running, restarted.State);
        Assert.Equal(ContainerState.Exited, killed.State);
        Assert.Equal(
            ["stop shop-web-1", "start shop-web-1", "pause shop-web-1", "unpause shop-web-1", "restart shop-web-1", "kill:SIGTERM shop-web-1"],
            Engine(harness).Changes);
        var audit = await AuditAsync(harness);
        foreach (var action in new[] { "container.stop", "container.start", "container.pause", "container.unpause", "container.restart", "container.kill" })
        {
            Assert.Contains(audit, e => e.Action == action && e.Result == "success" && e.Target == Web);
        }

        Assert.Contains(audit, e => e.Action == "container.stop" && e.Parameters!.Contains("\"timeoutSeconds\":\"5\"", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("../images/json")]
    [InlineData("web?force=1")]
    [InlineData("web%2f..")]
    [InlineData("")]
    public async Task A_name_that_could_reach_another_endpoint_is_refused_before_the_engine(string name)
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Operator);
        await using var hub = await ConnectAsync(harness);

        await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync<ContainerSummary>(nameof(ICoreHub.StopContainer), name, null, Cancel));
        await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync<ContainerDetails>(nameof(ICoreHub.InspectContainer), name, Cancel));
        await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync<ContainerSummary>(nameof(ICoreHub.KillContainer), Web, "SIGSTOP; rm -rf /", Cancel));

        Assert.Empty(Engine(harness).Changes);
        var audit = await AuditAsync(harness);
        Assert.Contains(audit, e => e.Action == "container.stop" && e.Result == "denied");
        Assert.Contains(audit, e => e.Action == "container.kill" && e.Result == "denied");
    }

    [Fact]
    public async Task Removing_with_volumes_is_for_admins_and_the_engine_s_refusals_come_through()
    {
        await using var operatorHarness = await AuthHarness.CreateAsync(CoreRoles.Operator);
        await using var operatorHub = await ConnectAsync(operatorHarness);
        await using var adminHarness = await AuthHarness.CreateAsync(CoreRoles.Admin);
        await using var adminHub = await ConnectAsync(adminHarness);

        var notAdmin = await Assert.ThrowsAsync<HubException>(() =>
            operatorHub.InvokeAsync(nameof(ICoreHub.RemoveContainer), new ContainerRemoveRequest("migrate-once", RemoveVolumes: true), Cancel));
        var running = await Assert.ThrowsAsync<HubException>(() =>
            adminHub.InvokeAsync(nameof(ICoreHub.RemoveContainer), new ContainerRemoveRequest(Web, RemoveVolumes: true), Cancel));
        await adminHub.InvokeAsync(nameof(ICoreHub.RemoveContainer), new ContainerRemoveRequest(Web, RemoveVolumes: true, Force: true), Cancel);
        await operatorHub.InvokeAsync(nameof(ICoreHub.RemoveContainer), new ContainerRemoveRequest("migrate-once"), Cancel);

        Assert.Contains("Admins", notAdmin.Message, StringComparison.Ordinal);
        Assert.Contains("container is running", running.Message, StringComparison.Ordinal);
        Assert.Equal(["remove migrate-once"], Engine(operatorHarness).Changes);
        Assert.Equal(["remove-with-volumes shop-web-1"], Engine(adminHarness).Changes);
        Assert.Contains(await AuditAsync(operatorHarness), e => e.Action == "container.remove" && e.Result == "denied" && e.Parameters!.Contains("\"removeVolumes\":\"true\"", StringComparison.Ordinal));
        Assert.Contains(await AuditAsync(adminHarness), e => e.Action == "container.remove" && e.Result == "failed");
        var volumes = await adminHub.InvokeAsync<VolumeInfo[]>(nameof(ICoreHub.ListVolumes), Cancel);
        Assert.DoesNotContain(volumes, volume => volume.ComposeProject is null && volume.Containers == 0 && volume.Name.Length == 64);
    }

    [Fact]
    public async Task Stats_arrive_in_batches_and_a_stopped_container_is_reported_once()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Operator, fakeClock: false);
        await using var hub = await ConnectAsync(harness);
        var id = (await hub.InvokeAsync<ContainerDetails>(nameof(ICoreHub.InspectContainer), Web, Cancel)).Summary.Id;

        await using var stream = hub.StreamAsync<ContainerStatsBatch>(
            nameof(ICoreHub.StreamContainerStats),
            new ContainerStatsRequest(IntervalMs: 1_000),
            Cancel).GetAsyncEnumerator(Cancel);
        var first = await ReadUntilAsync(stream, batches => batches.Count > 0 && batches[^1].Samples.Length >= 6);
        await hub.InvokeAsync<ContainerSummary>(nameof(ICoreHub.StopContainer), Web, null, Cancel);
        var after = await ReadUntilAsync(stream, batches => batches.Count > 0 && batches[^1].Stopped.Contains(id));

        var web = first[^1].Samples.Single(sample => sample.ContainerId == id);
        Assert.True(web.MemoryUsedBytes > 0);
        Assert.True(web.MemoryLimitBytes > web.MemoryUsedBytes);
        Assert.Equal(4, web.OnlineCpus);
        Assert.InRange(web.CpuPercent, 0, 400);
        Assert.DoesNotContain(first[^1].Samples, sample => sample.ContainerId.Length != 64);
        Assert.NotNull(after);
    }

    [Fact]
    public async Task A_connection_holds_two_stats_streams_at_most()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Viewer, fakeClock: false);
        await using var hub = await ConnectAsync(harness);
        var open = new List<IAsyncEnumerator<ContainerStatsBatch>>();
        for (var i = 0; i < StreamLimits.PerKind[StreamLimits.ContainerStats]; i++)
        {
            var stream = hub.StreamAsync<ContainerStatsBatch>(nameof(ICoreHub.StreamContainerStats), new ContainerStatsRequest(IntervalMs: 1_000), Cancel).GetAsyncEnumerator(Cancel);
            await ReadUntilAsync(stream, batches => batches.Count == 1);
            open.Add(stream);
        }

        var refusal = await Assert.ThrowsAsync<HubException>(async () =>
        {
            await foreach (var _ in hub.StreamAsync<ContainerStatsBatch>(nameof(ICoreHub.StreamContainerStats), new ContainerStatsRequest(), Cancel))
            {
            }
        });

        Assert.Contains("streams open", refusal.Message, StringComparison.Ordinal);
        foreach (var stream in open)
        {
            await stream.DisposeAsync();
        }
    }

    [Fact]
    public async Task Logs_are_redacted_with_the_container_s_own_values_and_resume_after_the_last_line()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Viewer, fakeClock: false);
        await using var hub = await ConnectAsync(harness);

        var lines = new List<ContainerLogLine>();
        await foreach (var batch in hub.StreamAsync<ContainerLogBatch>(nameof(ICoreHub.StreamContainerLogs), new ContainerLogsRequest("shop-api-1", Tail: 60, Follow: false), Cancel))
        {
            lines.AddRange(batch.Lines);
        }

        var resumed = new List<ContainerLogLine>();
        await foreach (var batch in hub.StreamAsync<ContainerLogBatch>(nameof(ICoreHub.StreamContainerLogs), new ContainerLogsRequest("shop-api-1", AfterTimestamp: lines[^10].Timestamp, Follow: false), Cancel))
        {
            resumed.AddRange(batch.Lines);
        }

        Assert.Equal(60, lines.Count);
        // Every value of the container's environment is masked, the whole DATABASE_URL included.
        Assert.Contains(lines, line => line.Stream == ContainerLogSource.Stderr && line.Text.Contains("retrying database connection " + Redactor.Mask, StringComparison.Ordinal));
        Assert.DoesNotContain(lines, line => line.Text.Contains(InMemoryDockerEngine.DatabasePassword, StringComparison.Ordinal));
        Assert.Equal(lines[^9..].Select(line => line.Timestamp), resumed.Take(9).Select(line => line.Timestamp));
        Assert.All(lines, line => Assert.True(line.AtUnixMs > 0));
    }

    [Fact]
    public async Task An_admin_console_runs_both_ways_and_only_its_opening_and_closing_are_recorded()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Admin, fakeClock: false);
        await using var hub = await ConnectAsync(harness);
        var input = Channel.CreateUnbounded<ConsoleInput>();

        await using var stream = hub.StreamAsync<ConsoleOutput>(
            nameof(ICoreHub.ContainerConsole),
            new ConsoleRequest("toolbox", 120, 40),
            input.Reader.ReadAllAsync(Cancel),
            Cancel).GetAsyncEnumerator(Cancel);
        var prompt = await ReadUntilAsync(stream, outputs => string.Concat(outputs.Select(o => o.Data)).Contains("# ", StringComparison.Ordinal));
        await input.Writer.WriteAsync(new ConsoleInput(Columns: 100, Rows: 30), Cancel);
        await input.Writer.WriteAsync(new ConsoleInput("echo top-secret-word\r"), Cancel);
        var echoed = await ReadUntilAsync(stream, outputs => string.Concat(outputs.Select(o => o.Data)).Contains("top-secret-word\r\nroot@", StringComparison.Ordinal));
        await input.Writer.WriteAsync(new ConsoleInput("exit\r"), Cancel);
        var ended = await ReadUntilAsync(stream, outputs => outputs.Count > 0 && outputs[^1].Ended);

        Assert.NotEmpty(prompt);
        Assert.NotEmpty(echoed);
        Assert.Equal(0, ended[^1].ExitCode);
        Assert.Contains(Engine(harness).Changes, change => change.StartsWith("exec toolbox /bin/sh -c", StringComparison.Ordinal));
        await Task.Delay(200, Cancel);
        var audit = await AuditAsync(harness);
        Assert.Contains(audit, e => e.Action == "container.console-open" && e.Result == "success" && e.Target == "toolbox");
        Assert.Contains(audit, e => e.Action == "container.console-close" && e.Result == "success" && e.Parameters!.Contains("\"exit\":\"0\"", StringComparison.Ordinal));
        Assert.DoesNotContain(audit, e => e.Parameters?.Contains("top-secret-word", StringComparison.Ordinal) == true);
    }

    [Fact]
    public async Task An_operator_pulls_an_image_as_a_job_with_layer_progress_and_a_bad_reference_is_refused()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Operator, fakeClock: false);
        await using var hub = await ConnectAsync(harness);

        var job = await hub.InvokeAsync<JobInfo>(nameof(ICoreHub.PullImage), new ImagePullRequest("redis:8.2"), Cancel);
        var finished = await harness.Services.GetRequiredService<JobEngine>().WhenFinishedAsync(job.Id, Cancel);
        var log = new List<JobLogLine>();
        await foreach (var item in hub.StreamAsync<JobStreamItem>(nameof(ICoreHub.StreamJob), job.Id, 0L, Cancel))
        {
            log.AddRange(item.Lines);
        }

        var bad = await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync<JobInfo>(nameof(ICoreHub.PullImage), new ImagePullRequest("Redis:latest; rm"), Cancel));

        Assert.Equal(JobKind.ImagePull, job.Kind);
        Assert.Equal(JobState.Succeeded, finished.State);
        Assert.Contains(log, line => line.Text.Contains(": Downloading", StringComparison.Ordinal) && line.Text.Contains(" of ", StringComparison.Ordinal));
        Assert.Contains(log, line => line.Text.Contains("Status: Downloaded newer image for redis:8.2", StringComparison.Ordinal));
        Assert.Contains("image reference", bad.Message, StringComparison.Ordinal);
        Assert.Contains(await hub.InvokeAsync<ImageInfo[]>(nameof(ICoreHub.ListImages), Cancel), image => image.Tags.Contains("redis:8.2"));
        var audit = await AuditAsync(harness);
        Assert.Contains(audit, e => e.Action == "image.pull" && e.Result == "success");
        Assert.Contains(audit, e => e.Action == "image.pull" && e.Result == "denied");
    }

    [Fact]
    public async Task Admins_prune_and_install_the_engine_and_events_follow_the_changes()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Admin, fakeClock: false);
        await using var hub = await ConnectAsync(harness);
        await using var events = hub.StreamAsync<DockerEvent>(nameof(ICoreHub.StreamDockerEvents), new DockerEventsRequest(SinceUnixMs: 0), Cancel).GetAsyncEnumerator(Cancel);

        var pruned = await hub.InvokeAsync<DockerPruneResult>(nameof(ICoreHub.PruneDocker), new DockerPruneRequest(DockerPruneTarget.System, AllImages: true), Cancel);
        var install = await hub.InvokeAsync<JobInfo>(nameof(ICoreHub.InstallDocker), new DockerInstallRequest(RemoveConflictingPackages: true), Cancel);
        await harness.Services.GetRequiredService<JobEngine>().WhenFinishedAsync(install.Id, Cancel);
        await hub.InvokeAsync<ContainerSummary>(nameof(ICoreHub.RestartContainer), "toolbox", 1, Cancel);
        var seen = await ReadUntilAsync(events, items => items.Any(e => e.Action == "restart"));

        Assert.True(pruned.Removed >= 1);
        Assert.Equal(JobKind.DockerInstall, install.Kind);
        Assert.Contains("docker.install removeConflicting=True", harness.Services.GetRequiredService<MutationLog>().Entries);
        var restart = seen.Single(e => e.Action == "restart");
        Assert.Equal(("container", "toolbox"), (restart.Type, restart.Name));
        Assert.Matches("^[0-9]+$", restart.Cursor);

        // Resuming from the restart's start event replays only what came after it.
        var start = seen.Last(e => e.Action == "start");
        await using var resumed = hub.StreamAsync<DockerEvent>(nameof(ICoreHub.StreamDockerEvents), new DockerEventsRequest(AfterCursor: start.Cursor), Cancel).GetAsyncEnumerator(Cancel);
        Assert.Equal("restart", (await ReadUntilAsync(resumed, items => items.Count == 1))[0].Action);
        var audit = await AuditAsync(harness);
        Assert.Contains(audit, e => e.Action == "docker.prune" && e.Result == "success" && e.Parameters!.Contains("\"target\":\"system\"", StringComparison.Ordinal));
        Assert.Contains(audit, e => e.Action == "docker.install" && e.Result == "success");
    }

    [Fact]
    public async Task A_stopped_engine_is_said_plainly()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Viewer);
        Engine(harness).Running = false;
        await using var hub = await ConnectAsync(harness);

        var refusal = await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync<ContainerList>(nameof(ICoreHub.ListContainers), Cancel));
        var status = await hub.InvokeAsync<DockerStatus>(nameof(ICoreHub.GetDockerStatus), Cancel);

        Assert.Contains("Docker is not running", refusal.Message, StringComparison.Ordinal);
        Assert.False(status.Running);
        Assert.True(status.Installed);
        Assert.Equal("Docker is installed but not running.", status.Message);
    }
}
