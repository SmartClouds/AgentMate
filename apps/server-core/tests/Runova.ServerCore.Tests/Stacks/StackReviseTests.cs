using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.DependencyInjection;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Docker;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Tests.Stacks;

/// <summary>
/// A new revision made on the server from an existing one (E12 updates, E13 "make private"): the
/// .env and the project files are copied, the compose file can be replaced and the proxied
/// services changed, so no env value ever travels. Also revealing a revision's .env, which is
/// for Admins after a step-up, with only the count in the audit.
/// </summary>
public sealed class StackReviseTests
{
    private static CancellationToken Cancel => StackKit.Cancel;

    private static ContainerSummary[] ContainersOf(StackKit kit, string project) =>
        [.. kit.Harness.Services.GetRequiredService<InMemoryDockerEngine>().ListContainersAsync(Cancel).Result
            .Select(c => c.Summary).Where(c => c.ComposeProject == project)];

    private static Task<StackRevisionInfo> ReviseAsync(StackKit kit, ReviseStackRequest request) =>
        kit.Hub.InvokeAsync<StackRevisionInfo>(nameof(ICoreHub.ReviseStack), request, Cancel);

    [Fact]
    public async Task Making_a_service_private_copies_the_live_revision_with_the_service_on_loopback()
    {
        await using var kit = await StackKit.CreateAsync(CoreRoles.Operator);
        var stack = await kit.CreateStackAsync();
        await kit.UploadAsync(stack.Id, StackKit.Upload(proxied: [], acknowledged: ["public-port:web:*:8080:80/tcp"]));
        await kit.RunAsync(await kit.DeployAsync(stack.Id, 1));
        Assert.Contains(ContainersOf(kit, "site").SelectMany(c => c.Ports), port => port.HostIp is null or "0.0.0.0");

        var revision = await ReviseAsync(kit, new ReviseStackRequest(stack.Id, 1, ["web"], Purpose: StackRevisionPurpose.MakePrivate));
        var (job, _) = await kit.RunAsync(await kit.DeployAsync(stack.Id, revision.Number));
        var files = await kit.Hub.InvokeAsync<StackRevisionFiles>(nameof(ICoreHub.GetStackRevisionFiles), new StackRevisionRef(stack.Id, 2), Cancel);

        Assert.Equal((2, StackRevisionState.Ready), (revision.Number, revision.State));
        Assert.Equal(["web"], revision.ProxiedServices);
        Assert.Equal(["DB_PASSWORD"], revision.EnvKeys);
        Assert.Empty(revision.UnacknowledgedRisks);
        Assert.Equal("Shop", revision.Source?.ProjectName);
        Assert.Equal(JobState.Succeeded, job.State);
        Assert.Equal(StackKit.Compose, files.Compose);
        Assert.Contains("!override", files.Override, StringComparison.Ordinal);
        var binding = Assert.Single(revision.Bindings);
        Assert.Equal("127.0.0.1", binding.HostIp);
        Assert.All(ContainersOf(kit, "site").SelectMany(c => c.Ports), port => Assert.Equal("127.0.0.1", port.HostIp));
        // The .env came along on the server: the container still has the value.
        var container = Assert.Single(ContainersOf(kit, "site"));
        var inspection = await kit.Harness.Services.GetRequiredService<InMemoryDockerEngine>().InspectContainerAsync(container.Id, Cancel);
        Assert.Contains(new KeyValuePair<string, string>("DB_PASSWORD", StackKit.Secret), inspection.Environment);
        var audit = await kit.AuditAsync();
        Assert.Contains(audit, e => e.Action == "stack.revise" && e.Result == "success" && e.Parameters!.Contains("make-private", StringComparison.Ordinal));
    }

    [Fact]
    public async Task An_update_replaces_the_compose_file_and_keeps_the_env_on_the_server()
    {
        await using var kit = await StackKit.CreateAsync(CoreRoles.Operator);
        var stack = await kit.CreateStackAsync();
        await kit.UploadAsync(stack.Id, StackKit.Upload());
        await kit.RunAsync(await kit.DeployAsync(stack.Id, 1));
        var newer = StackKit.Compose.Replace("nginx:1.29", "nginx:1.30", StringComparison.Ordinal);

        var revision = await ReviseAsync(kit, new ReviseStackRequest(stack.Id, 1, ["web"], newer, Purpose: StackRevisionPurpose.Update));
        await kit.RunAsync(await kit.DeployAsync(stack.Id, revision.Number));
        var files = await kit.Hub.InvokeAsync<StackRevisionFiles>(nameof(ICoreHub.GetStackRevisionFiles), new StackRevisionRef(stack.Id, 2), Cancel);

        Assert.Equal(newer, files.Compose);
        Assert.Equal(["DB_PASSWORD"], files.EnvKeys);
        Assert.Equal("nginx:1.30", Assert.Single(ContainersOf(kit, "site")).Image);
        Assert.Contains(await kit.AuditAsync(), e => e.Action == "stack.revise" && e.Parameters!.Contains("update", StringComparison.Ordinal));

        // And it rolls back like any revision.
        var (back, _) = await kit.RunAsync(await kit.Hub.InvokeAsync<JobInfo>(nameof(ICoreHub.RollbackStack), new StackRevisionRef(stack.Id, 1), Cancel));
        Assert.Equal(JobState.Succeeded, back.State);
        Assert.Equal("nginx:1.29", Assert.Single(ContainersOf(kit, "site")).Image);
    }

    [Fact]
    public async Task A_compose_file_that_reads_a_missing_env_key_makes_an_invalid_revision()
    {
        await using var kit = await StackKit.CreateAsync(CoreRoles.Operator);
        var stack = await kit.CreateStackAsync();
        await kit.UploadAsync(stack.Id, StackKit.Upload());
        var missing = StackKit.Compose.Replace("${DB_PASSWORD}", "${OTHER_KEY:?OTHER_KEY is missing from the .env file}", StringComparison.Ordinal);

        var revision = await ReviseAsync(kit, new ReviseStackRequest(stack.Id, 1, ["web"], missing));

        Assert.Equal(StackRevisionState.Invalid, revision.State);
        Assert.Contains("OTHER_KEY", revision.Error, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Bad_requests_are_refused_and_audited()
    {
        await using var kit = await StackKit.CreateAsync(CoreRoles.Operator);
        var stack = await kit.CreateStackAsync();
        await kit.UploadAsync(stack.Id, StackKit.Upload());

        var noSuchRevision = await Assert.ThrowsAsync<HubException>(() => ReviseAsync(kit, new ReviseStackRequest(stack.Id, 7, ["web"])));
        var badService = await Assert.ThrowsAsync<HubException>(() => ReviseAsync(kit, new ReviseStackRequest(stack.Id, 1, ["web; rm -rf /"])));
        var empty = await Assert.ThrowsAsync<HubException>(() => ReviseAsync(kit, new ReviseStackRequest(stack.Id, 1, ["web"], "   ")));
        var huge = await Assert.ThrowsAsync<HubException>(() => ReviseAsync(kit, new ReviseStackRequest(stack.Id, 1, ["web"], AcknowledgedRisks: ["no spaces allowed"])));

        Assert.Contains("revision", noSuchRevision.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("service", badService.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("empty", empty.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("findings", huge.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(1, (await kit.GetAsync(stack.Id)).Stack.RevisionCount);
        Assert.Contains(await kit.AuditAsync(), e => e.Action == "stack.revise" && e.Result == "denied");
    }

    [Fact]
    public async Task A_viewer_cannot_revise()
    {
        await using var kit = await StackKit.CreateAsync(CoreRoles.Viewer);
        await Assert.ThrowsAsync<HubException>(() => ReviseAsync(kit, new ReviseStackRequest(Guid.NewGuid(), 1, [])));
    }

    [Fact]
    public async Task Revealing_the_env_is_for_admins_after_a_step_up_and_only_the_count_is_audited()
    {
        await using var operatorKit = await StackKit.CreateAsync(CoreRoles.Operator);
        var stack = await operatorKit.CreateStackAsync();
        await operatorKit.UploadAsync(stack.Id, StackKit.Upload());
        await operatorKit.Hub.InvokeAsync<StepUpResponse>(nameof(ICoreHub.StepUp), new StepUpRequest(AuthHarness.Password), Cancel);
        await Assert.ThrowsAsync<HubException>(() =>
            operatorKit.Hub.InvokeAsync<StackEnvEntry[]>(nameof(ICoreHub.RevealStackEnv), new StackRevisionRef(stack.Id, 1), Cancel));

        await using var kit = await StackKit.CreateAsync(CoreRoles.Admin);
        var own = await kit.CreateStackAsync("vault");
        await kit.UploadAsync(own.Id, StackKit.Upload());
        await Assert.ThrowsAsync<HubException>(() =>
            kit.Hub.InvokeAsync<StackEnvEntry[]>(nameof(ICoreHub.RevealStackEnv), new StackRevisionRef(own.Id, 1), Cancel));
        await kit.Hub.InvokeAsync<StepUpResponse>(nameof(ICoreHub.StepUp), new StepUpRequest(AuthHarness.Password), Cancel);
        var revealed = await kit.Hub.InvokeAsync<StackEnvEntry[]>(nameof(ICoreHub.RevealStackEnv), new StackRevisionRef(own.Id, 1), Cancel);

        Assert.Equal([new StackEnvEntry("DB_PASSWORD", StackKit.Secret)], revealed);
        var audit = await kit.AuditAsync();
        var entry = Assert.Single(audit, e => e.Action == "stack.env-reveal" && e.Result == "success");
        Assert.DoesNotContain(StackKit.Secret, entry.Parameters ?? string.Empty, StringComparison.Ordinal);
        Assert.DoesNotContain("DB_PASSWORD", entry.Parameters ?? string.Empty, StringComparison.Ordinal);
    }
}
