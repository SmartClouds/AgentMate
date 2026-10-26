using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Runova.ServerCore.Alerts;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Jobs;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Tests;

/// <summary>
/// The server side of the hub through a real connection: every role reads, Operators run updates,
/// restarts and reboots (upgrading everything and rebooting need a step-up), Admins switch automatic
/// updates, and every change lands in the audit trail.
/// </summary>
public sealed class HubServerTests
{
    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private static async Task<HubConnection> ConnectAsync(AuthHarness harness)
    {
        var signedIn = await harness.SignInAsync();
        var hub = harness.Hub(signedIn.AccessToken);
        await hub.StartAsync(Cancel);
        return hub;
    }

    private static async Task<JobInfo> FinishedAsync(AuthHarness harness, JobInfo job) =>
        await harness.Services.GetRequiredService<JobEngine>().WhenFinishedAsync(job.Id, Cancel);

    private static async Task<List<string>> AuditActionsAsync(AuthHarness harness)
    {
        await using var scope = harness.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<CoreDbContext>();
        return await db.AuditEvents.OrderBy(e => e.Id).Select(e => e.Action + ":" + e.Result).ToListAsync(Cancel);
    }

    [Fact]
    public async Task A_viewer_reads_the_server()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Viewer);
        await using var hub = await ConnectAsync(harness);

        var info = await hub.InvokeAsync<SystemInfo>(nameof(ICoreHub.GetSystemInfo), Cancel);
        var services = await hub.InvokeAsync<ServiceInfo[]>(nameof(ICoreHub.ListServices), Cancel);
        var updates = await hub.InvokeAsync<UpdatesInfo>(nameof(ICoreHub.GetUpdates), Cancel);
        var jobs = await hub.InvokeAsync<JobPage>(nameof(ICoreHub.ListJobs), new JobQuery(), Cancel);
        var alerts = await hub.InvokeAsync<AlertInfo[]>(nameof(ICoreHub.ListAlerts), new AlertQuery(), Cancel);
        var history = await hub.InvokeAsync<MetricsHistory>(
            nameof(ICoreHub.GetMetricsHistory),
            new MetricsHistoryRequest(MetricsResolution.Minute),
            Cancel);

        Assert.Equal("web-01", info.Hostname);
        Assert.Contains(services, s => s.Unit == "docker.service" && s.CanRestart);
        Assert.Equal("apt", updates.PackageManager);
        Assert.Empty(jobs.Jobs);
        Assert.Empty(alerts);
        Assert.Equal(60, history.IntervalSeconds);
    }

    [Fact]
    public async Task An_operator_upgrades_security_packages_as_a_job_on_the_audit_trail()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Operator);
        await using var hub = await ConnectAsync(harness);

        var job = await hub.InvokeAsync<JobInfo>(nameof(ICoreHub.UpgradeSecurityPackages), Cancel);
        var finished = await FinishedAsync(harness, job);
        var fetched = await hub.InvokeAsync<JobInfo>(nameof(ICoreHub.GetJob), job.Id, Cancel);

        Assert.Equal(JobKind.PackagesUpgradeSecurity, job.Kind);
        Assert.Equal(JobState.Succeeded, finished.State);
        Assert.Equal(JobState.Succeeded, fetched.State);
        Assert.Equal("maria", fetched.RequestedBy);
        Assert.Contains("packages.upgrade-security", harness.Services.GetRequiredService<MutationLog>().Entries);
        var audit = await AuditActionsAsync(harness);
        Assert.Contains("packages.upgrade-security:success", audit);
        Assert.Contains("job.finished:success", audit);
    }

    [Fact]
    public async Task Upgrading_everything_needs_a_step_up()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Operator);
        await using var hub = await ConnectAsync(harness);

        var refused = await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync<JobInfo>(nameof(ICoreHub.UpgradeAllPackages), Cancel));
        await hub.InvokeAsync<StepUpResponse>(nameof(ICoreHub.StepUp), new StepUpRequest(AuthHarness.Password), Cancel);
        var job = await hub.InvokeAsync<JobInfo>(nameof(ICoreHub.UpgradeAllPackages), Cancel);

        Assert.Contains("unauthorized", refused.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(JobState.Succeeded, (await FinishedAsync(harness, job)).State);
        Assert.Equal(["packages.upgrade"], harness.Services.GetRequiredService<MutationLog>().Entries);
    }

    [Fact]
    public async Task A_reboot_needs_a_step_up_and_is_scheduled_after_its_job_succeeds()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Operator);
        await using var hub = await ConnectAsync(harness);

        await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync<JobInfo>(nameof(ICoreHub.RebootServer), Cancel));
        await hub.InvokeAsync<StepUpResponse>(nameof(ICoreHub.StepUp), new StepUpRequest(AuthHarness.Password), Cancel);
        var reboot = await hub.InvokeAsync<JobInfo>(nameof(ICoreHub.RebootServer), Cancel);

        Assert.Equal(JobState.Succeeded, (await FinishedAsync(harness, reboot)).State);
        Assert.Equal(["power.reboot-in=5s"], harness.Services.GetRequiredService<MutationLog>().Entries);
        Assert.Contains("system.reboot:success", await AuditActionsAsync(harness));
    }

    [Fact]
    public async Task A_second_package_job_is_refused_while_one_runs()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Operator);
        var packages = harness.Services.GetRequiredService<FakePackageManager>();
        packages.UpgradeGate = new TaskCompletionSource();
        await using var hub = await ConnectAsync(harness);

        var first = await hub.InvokeAsync<JobInfo>(nameof(ICoreHub.UpgradeSecurityPackages), Cancel);
        var refusal = await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync<JobInfo>(nameof(ICoreHub.CheckForUpdates), Cancel));
        packages.UpgradeGate.SetResult();
        await FinishedAsync(harness, first);

        Assert.Contains("Another job is already working on packages", refusal.Message, StringComparison.Ordinal);
        Assert.Contains("packages.check:failed", await AuditActionsAsync(harness));
    }

    [Fact]
    public async Task An_operator_cancels_a_running_job_and_a_finished_one_cannot_be_cancelled()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Operator);
        var packages = harness.Services.GetRequiredService<FakePackageManager>();
        packages.UpgradeGate = new TaskCompletionSource();
        await using var hub = await ConnectAsync(harness);

        var job = await hub.InvokeAsync<JobInfo>(nameof(ICoreHub.UpgradeSecurityPackages), Cancel);
        await hub.InvokeAsync(nameof(ICoreHub.CancelJob), job.Id, Cancel);
        var cancelled = await FinishedAsync(harness, job);
        var again = await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync(nameof(ICoreHub.CancelJob), job.Id, Cancel));
        var unknown = await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync(nameof(ICoreHub.CancelJob), Guid.NewGuid(), Cancel));

        Assert.Equal(JobState.Cancelled, cancelled.State);
        Assert.Contains("already finished", again.Message, StringComparison.Ordinal);
        Assert.Contains("no such job", unknown.Message, StringComparison.Ordinal);
        Assert.Contains("job.cancel:success", await AuditActionsAsync(harness));
    }

    [Fact]
    public async Task Only_docker_and_nginx_can_be_restarted()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Operator);
        await using var hub = await ConnectAsync(harness);

        var docker = await hub.InvokeAsync<JobInfo>(nameof(ICoreHub.RestartService), ManagedService.Docker, Cancel);
        // An enum travels as a name, but JSON would also accept a number; one that names nothing is refused.
        var unknown = await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync<JobInfo>(nameof(ICoreHub.RestartService), 42, Cancel));

        Assert.Equal(JobState.Succeeded, (await FinishedAsync(harness, docker)).State);
        Assert.Contains("Only Docker and nginx", unknown.Message, StringComparison.Ordinal);
        Assert.Contains("service.restart:success", await AuditActionsAsync(harness));
    }

    [Fact]
    public async Task An_operator_acknowledges_an_alert()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Operator);
        var alert = await harness.Services.GetRequiredService<AlertCenter>()
            .RaiseAsync(AlertKind.DiskPressure, "/", AlertSeverity.Warning, "/ is 91% full", Cancel);
        await using var hub = await ConnectAsync(harness);

        var acknowledged = await hub.InvokeAsync<AlertInfo>(nameof(ICoreHub.AcknowledgeAlert), alert.Id, Cancel);
        var missing = await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync<AlertInfo>(nameof(ICoreHub.AcknowledgeAlert), 999L, Cancel));

        Assert.Equal("maria", acknowledged.AcknowledgedBy);
        Assert.Contains("no such alert", missing.Message, StringComparison.Ordinal);
        Assert.Contains("alert.acknowledge:success", await AuditActionsAsync(harness));
    }

    [Fact]
    public async Task Automatic_updates_are_for_admins()
    {
        await using var operatorHarness = await AuthHarness.CreateAsync(CoreRoles.Operator);
        await using var operatorHub = await ConnectAsync(operatorHarness);
        await using var adminHarness = await AuthHarness.CreateAsync(CoreRoles.Admin);
        await using var adminHub = await ConnectAsync(adminHarness);

        await Assert.ThrowsAsync<HubException>(() => operatorHub.InvokeAsync<JobInfo>(nameof(ICoreHub.SetAutomaticSecurityUpdates), true, Cancel));
        var job = await adminHub.InvokeAsync<JobInfo>(nameof(ICoreHub.SetAutomaticSecurityUpdates), true, Cancel);

        Assert.Equal(JobState.Succeeded, (await FinishedAsync(adminHarness, job)).State);
        Assert.Contains("packages.automatic=True", adminHarness.Services.GetRequiredService<MutationLog>().Entries);
        Assert.Empty(operatorHarness.Services.GetRequiredService<MutationLog>().Entries);
    }
}
