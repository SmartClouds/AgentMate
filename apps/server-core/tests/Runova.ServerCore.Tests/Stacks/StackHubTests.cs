using System.Net;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.DependencyInjection;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Docker;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Tests.Stacks;

/// <summary>
/// Compose stacks through a real hub connection and the REST uploads, on the pretend engine and
/// the simulated docker compose: a deploy as a job with its steps, the loopback override, the
/// findings that have to be acknowledged, rollback, lifecycle and the roles that may do each.
/// </summary>
public sealed class StackHubTests
{
    private static CancellationToken Cancel => StackKit.Cancel;

    private static InMemoryDockerEngine Engine(StackKit kit) => kit.Harness.Services.GetRequiredService<InMemoryDockerEngine>();

    private static ContainerSummary[] ContainersOf(StackKit kit, string project) =>
        [.. Engine(kit).ListContainersAsync(Cancel).Result.Select(c => c.Summary).Where(c => c.ComposeProject == project)];

    [Fact]
    public async Task An_operator_creates_an_app_uploads_it_and_deploys_it_step_by_step_on_loopback()
    {
        await using var kit = await StackKit.CreateAsync(CoreRoles.Operator);
        var stack = await kit.CreateStackAsync();

        var revision = await kit.UploadAsync(stack.Id, StackKit.Upload());
        var (job, log) = await kit.RunAsync(await kit.DeployAsync(stack.Id, revision.Number));
        var details = await kit.GetAsync(stack.Id);

        Assert.Equal(StackStatus.New, stack.Status);
        Assert.Equal(StackRevisionState.Ready, revision.State);
        Assert.Equal(["DB_PASSWORD"], revision.EnvKeys);
        Assert.Equal(["web"], revision.Services);
        Assert.Equal(JobKind.StackDeploy, job.Kind);
        Assert.Equal(JobState.Succeeded, job.State);
        var live = details.Revisions[0];
        Assert.Equal(StackRevisionState.Live, live.State);
        Assert.Equal(
            [StackStepKind.Validate, StackStepKind.Pull, StackStepKind.Build, StackStepKind.Up, StackStepKind.Health],
            live.Steps.Select(step => step.Kind));
        Assert.Equal(StackStepState.Skipped, live.Steps[2].State);
        Assert.All(live.Steps.Where(step => step.Kind != StackStepKind.Build), step => Assert.Equal(StackStepState.Succeeded, step.State));
        // Each step's lines are its own: the ranges follow one another through the job log.
        var ranged = live.Steps.Where(step => step.FirstLogSeq is not null).ToList();
        Assert.All(ranged, step => Assert.True(step.LastLogSeq >= step.FirstLogSeq));
        Assert.True(ranged.Zip(ranged.Skip(1)).All(pair => pair.Second.FirstLogSeq > pair.First.LastLogSeq));
        Assert.Equal(1, details.Stack.LiveRevision);
        Assert.Equal(StackStatus.Running, details.Stack.Status);
        var binding = Assert.Single(live.Bindings);
        Assert.Equal(("web", 80, "127.0.0.1", "8080"), (binding.Service, binding.Target, binding.HostIp, binding.Published));
        var container = Assert.Single(ContainersOf(kit, "site"));
        Assert.All(container.Ports, port => Assert.Equal("127.0.0.1", port.HostIp));
        Assert.Equal("web", Assert.Single(details.Services).Name);
        // The env value was seeded into the redactor: whatever compose printed, it never shows.
        Assert.DoesNotContain(log, line => line.Text.Contains(StackKit.Secret, StringComparison.Ordinal));
        var files = await kit.Hub.InvokeAsync<StackRevisionFiles>(nameof(ICoreHub.GetStackRevisionFiles), new StackRevisionRef(stack.Id, 1), Cancel);
        Assert.Equal(StackKit.Compose, files.Compose);
        Assert.Contains("!override", files.Override, StringComparison.Ordinal);
        Assert.DoesNotContain(StackKit.Secret, files.Override ?? string.Empty, StringComparison.Ordinal);
        var audit = await kit.AuditAsync();
        Assert.Contains(audit, e => e.Action == "stack.create" && e.Result == "success");
        Assert.Contains(audit, e => e.Action == "stack.revision-upload" && e.Result == "success");
        Assert.Contains(audit, e => e.Action == "stack.deploy" && e.Result == "success");
        Assert.DoesNotContain(audit, e => e.Parameters?.Contains(StackKit.Secret, StringComparison.Ordinal) == true);
    }

    [Fact]
    public async Task A_finding_waits_for_its_acknowledgment_which_is_audited_once_per_id()
    {
        await using var kit = await StackKit.CreateAsync(CoreRoles.Operator);
        var stack = await kit.CreateStackAsync();
        const string Risky = "services:\n  agent:\n    image: example/agent:1.0\n    privileged: true\n    ports:\n      - \"9000:9000\"\n";

        var revision = await kit.UploadAsync(stack.Id, StackKit.Upload(Risky, proxied: []));
        var refused = await Assert.ThrowsAsync<HubException>(() => kit.DeployAsync(stack.Id, revision.Number));
        var acknowledged = await kit.Hub.InvokeAsync<StackRevisionInfo>(
            nameof(ICoreHub.AcknowledgeStackRisks),
            new AcknowledgeStackRisksRequest(stack.Id, revision.Number, ["privileged:agent", "public-port:agent:*:9000:9000/tcp"]),
            Cancel);
        var (job, _) = await kit.RunAsync(await kit.DeployAsync(stack.Id, revision.Number));

        Assert.Equal(["privileged:agent", "public-port:agent:*:9000:9000/tcp"], revision.UnacknowledgedRisks.Order(StringComparer.Ordinal));
        Assert.Contains("privileged:agent", refused.Message, StringComparison.Ordinal);
        Assert.Empty(acknowledged.UnacknowledgedRisks);
        Assert.Equal(JobState.Succeeded, job.State);
        // Left public on purpose: the port stays on every interface.
        Assert.Contains(ContainersOf(kit, "site").SelectMany(c => c.Ports), port => port.HostIp is null or "0.0.0.0");
        var audit = await kit.AuditAsync();
        Assert.Equal(2, audit.Count(e => e.Action == "stack.risk-acknowledge" && e.Result == "success"));
        Assert.Contains(audit, e => e.Action == "stack.risk-acknowledge" && e.Parameters!.Contains("privileged:agent", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Acknowledgments_sent_with_the_upload_count_at_once()
    {
        await using var kit = await StackKit.CreateAsync(CoreRoles.Operator);
        var stack = await kit.CreateStackAsync();
        const string Risky = "services:\n  agent:\n    image: example/agent:1.0\n    pid: host\n";

        var revision = await kit.UploadAsync(stack.Id, StackKit.Upload(Risky, proxied: [], acknowledged: ["host-pid:agent"]));

        Assert.Equal(["host-pid:agent"], revision.AcknowledgedRisks);
        Assert.Empty(revision.UnacknowledgedRisks);
        Assert.Single(await kit.AuditAsync(), e => e.Action == "stack.risk-acknowledge");
    }

    [Fact]
    public async Task Rolling_back_copies_the_earlier_revision_into_a_new_one_and_runs_its_files_again()
    {
        await using var kit = await StackKit.CreateAsync(CoreRoles.Operator);
        var stack = await kit.CreateStackAsync();
        var second = StackKit.Compose.Replace("nginx:1.29", "nginx:1.30", StringComparison.Ordinal);

        var first = await kit.UploadAsync(stack.Id, StackKit.Upload());
        await kit.RunAsync(await kit.DeployAsync(stack.Id, 1));
        await kit.UploadAsync(stack.Id, StackKit.Upload(second));
        await kit.RunAsync(await kit.DeployAsync(stack.Id, 2));
        Assert.Equal("nginx:1.30", Assert.Single(ContainersOf(kit, "site")).Image);

        var (job, _) = await kit.RunAsync(await kit.Hub.InvokeAsync<JobInfo>(nameof(ICoreHub.RollbackStack), new StackRevisionRef(stack.Id, 1), Cancel));
        var details = await kit.GetAsync(stack.Id);
        var files = await kit.Hub.InvokeAsync<StackRevisionFiles>(nameof(ICoreHub.GetStackRevisionFiles), new StackRevisionRef(stack.Id, 3), Cancel);

        Assert.Equal(JobState.Succeeded, job.State);
        Assert.Equal(3, details.Stack.LiveRevision);
        Assert.Equal([3, 2, 1], details.Revisions.Select(r => r.Number));
        Assert.Equal((StackRevisionState.Live, 1), (details.Revisions[0].State, details.Revisions[0].RollbackOf!.Value));
        Assert.Equal(StackRevisionState.Superseded, details.Revisions[1].State);
        Assert.Equal(first.ComposeSha256, details.Revisions[0].ComposeSha256);
        Assert.Equal(StackKit.Compose, files.Compose);
        Assert.Equal("nginx:1.29", Assert.Single(ContainersOf(kit, "site")).Image);
        var refused = await Assert.ThrowsAsync<HubException>(() => kit.Hub.InvokeAsync<JobInfo>(nameof(ICoreHub.RollbackStack), new StackRevisionRef(stack.Id, 3), Cancel));
        Assert.Contains("what runs now", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_failed_pull_fails_its_step_and_the_revision_and_nothing_else_runs()
    {
        await using var kit = await StackKit.CreateAsync(CoreRoles.Operator);
        var stack = await kit.CreateStackAsync();
        await kit.UploadAsync(stack.Id, StackKit.Upload());
        kit.Simulated.Failing["pull"] = true;

        var (job, _) = await kit.RunAsync(await kit.DeployAsync(stack.Id, 1));
        var revision = (await kit.GetAsync(stack.Id)).Revisions[0];

        Assert.Equal(JobState.Failed, job.State);
        Assert.Equal(StackRevisionState.Failed, revision.State);
        Assert.Equal(StackStepState.Failed, revision.Steps.Single(s => s.Kind == StackStepKind.Pull).State);
        Assert.NotNull(revision.Steps.Single(s => s.Kind == StackStepKind.Pull).Detail);
        Assert.All(revision.Steps.Where(s => s.Kind is StackStepKind.Up or StackStepKind.Health), s => Assert.NotEqual(StackStepState.Succeeded, s.State));
        Assert.Empty(ContainersOf(kit, "site"));
    }

    [Fact]
    public async Task The_lifecycle_runs_on_the_live_revision_and_delete_keeps_or_takes_the_volumes_by_role()
    {
        await using var kit = await StackKit.CreateAsync(CoreRoles.Operator);
        var stack = await kit.CreateStackAsync();
        var early = await Assert.ThrowsAsync<HubException>(() => kit.Hub.InvokeAsync<JobInfo>(nameof(ICoreHub.RunStackAction), new StackActionRequest(stack.Id, StackAction.Stop), Cancel));
        await kit.UploadAsync(stack.Id, StackKit.Upload());
        await kit.RunAsync(await kit.DeployAsync(stack.Id, 1));

        var (stopped, _) = await kit.RunAsync(await kit.Hub.InvokeAsync<JobInfo>(nameof(ICoreHub.RunStackAction), new StackActionRequest(stack.Id, StackAction.Stop), Cancel));
        var afterStop = (await kit.GetAsync(stack.Id)).Stack.Status;
        await kit.RunAsync(await kit.Hub.InvokeAsync<JobInfo>(nameof(ICoreHub.RunStackAction), new StackActionRequest(stack.Id, StackAction.Start), Cancel));
        var afterStart = (await kit.GetAsync(stack.Id)).Stack.Status;
        var withVolumes = await Assert.ThrowsAsync<HubException>(() => kit.Hub.InvokeAsync<JobInfo>(nameof(ICoreHub.DeleteStackWithVolumes), stack.Id, Cancel));
        var (deleted, _) = await kit.RunAsync(await kit.Hub.InvokeAsync<JobInfo>(nameof(ICoreHub.DeleteStack), stack.Id, Cancel));

        Assert.Contains("Deploy the app first", early.Message, StringComparison.Ordinal);
        Assert.Equal((JobKind.StackAction, JobState.Succeeded), (stopped.Kind, stopped.State));
        Assert.Equal(StackStatus.Stopped, afterStop);
        Assert.Equal(StackStatus.Running, afterStart);
        Assert.Contains("unauthorized", withVolumes.Message, StringComparison.Ordinal);
        Assert.Equal((JobKind.StackDelete, JobState.Succeeded), (deleted.Kind, deleted.State));
        Assert.Empty(await kit.Hub.InvokeAsync<StackInfo[]>(nameof(ICoreHub.ListStacks), Cancel));
        Assert.Empty(ContainersOf(kit, "site"));
        Assert.False(Directory.Exists(Path.Combine(kit.DataDirectory, "stacks", stack.Id.ToString("N"))));
        Assert.Contains(kit.Simulated.Calls, call => call.StartsWith("site down", StringComparison.Ordinal) && !call.Contains("--volumes", StringComparison.Ordinal));
    }

    [Fact]
    public async Task An_admin_deletes_an_app_with_its_volumes()
    {
        await using var kit = await StackKit.CreateAsync(CoreRoles.Admin);
        var stack = await kit.CreateStackAsync();
        await kit.UploadAsync(stack.Id, StackKit.Upload());
        await kit.RunAsync(await kit.DeployAsync(stack.Id, 1));

        var (deleted, _) = await kit.RunAsync(await kit.Hub.InvokeAsync<JobInfo>(nameof(ICoreHub.DeleteStackWithVolumes), stack.Id, Cancel));

        Assert.Equal(JobState.Succeeded, deleted.State);
        Assert.Contains(kit.Simulated.Calls, call => call.StartsWith("site down", StringComparison.Ordinal) && call.Contains("--volumes", StringComparison.Ordinal));
        Assert.Contains(await kit.AuditAsync(), e => e.Action == "stack.delete" && e.Parameters!.Contains("true", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_viewer_reads_apps_but_cannot_create_upload_or_deploy()
    {
        await using var kit = await StackKit.CreateAsync(CoreRoles.Viewer);

        var list = await kit.Hub.InvokeAsync<StackInfo[]>(nameof(ICoreHub.ListStacks), Cancel);
        var create = await Assert.ThrowsAsync<HubException>(() => kit.CreateStackAsync());
        var deploy = await Assert.ThrowsAsync<HubException>(() => kit.DeployAsync(Guid.NewGuid(), 1));
        using var upload = await kit.PostRevisionAsync(Guid.NewGuid(), StackKit.Upload());

        Assert.Empty(list);
        Assert.Contains("unauthorized", create.Message, StringComparison.Ordinal);
        Assert.Contains("unauthorized", deploy.Message, StringComparison.Ordinal);
        Assert.Equal(HttpStatusCode.Forbidden, upload.StatusCode);
    }

    [Fact]
    public async Task Names_are_compose_project_names_and_each_is_taken_once()
    {
        await using var kit = await StackKit.CreateAsync(CoreRoles.Operator);
        await kit.CreateStackAsync();

        var bad = await Assert.ThrowsAsync<HubException>(() => kit.CreateStackAsync("Shop App"));
        var twice = await Assert.ThrowsAsync<HubException>(() => kit.CreateStackAsync());

        Assert.NotEmpty(bad.Message);
        Assert.Contains("already an app called site", twice.Message, StringComparison.Ordinal);
    }
}
