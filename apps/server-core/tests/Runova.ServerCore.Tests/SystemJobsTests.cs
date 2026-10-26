using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using Runova.ServerCore.Alerts;
using Runova.ServerCore.Audit;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Hosting;
using Runova.ServerCore.Jobs;
using Runova.ServerCore.Security;
using Runova.ServerCore.Updates;

namespace Runova.ServerCore.Tests;

/// <summary>
/// The work behind the Overview's buttons, each as a job: checking for updates, upgrading everything
/// or only security fixes, switching automatic security updates, restarting Docker or nginx, and a
/// reboot that records its success before the machine goes down.
/// </summary>
public sealed class SystemJobsTests : IAsyncLifetime
{
    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private static readonly Requester _maria = new(Guid.NewGuid(), "maria");

    private readonly FakeTimeProvider _clock = new(DateTimeOffset.FromUnixTimeMilliseconds(1_800_000_000_000));
    private readonly MutationLog _mutations = new();
    private readonly string _data = TestFolders.Create("core-system-jobs");
    private TestDatabase _database = null!;
    private FakePackageManager _packages = null!;
    private FakeServiceManager _services = null!;
    private JobEngine _engine = null!;
    private UpdatesCache _updates = null!;
    private SystemJobs _jobs = null!;

    public async ValueTask InitializeAsync()
    {
        _database = await TestDatabase.CreateAsync();
        _packages = new FakePackageManager(_mutations);
        _services = new FakeServiceManager(_mutations);
        var alerts = new AlertCenter(_database.Contexts, _clock, new Redactor(), NullLogger<AlertCenter>.Instance);
        _engine = new JobEngine(
            _database.Contexts,
            _clock,
            new Redactor(),
            new AuditLog(_database.Contexts, _clock, new Redactor()),
            alerts,
            new CoreDirectories(_data),
            NullLogger<JobEngine>.Instance);
        _updates = new UpdatesCache(_packages, _clock, NullLogger<UpdatesCache>.Instance);
        _jobs = new SystemJobs(_engine, _packages, _services, new FakePowerControl(_mutations), _updates);
    }

    public async ValueTask DisposeAsync()
    {
        _updates.Dispose();
        await _database.DisposeAsync();
        TestFolders.Delete(_data);
    }

    private Task<JobInfo> FinishedAsync(JobInfo job) => _engine.WhenFinishedAsync(job.Id, Cancel);

    [Fact]
    public void Before_any_check_the_updates_are_unknown()
    {
        var updates = _updates.Current;

        Assert.Null(updates.CheckedAtUnixMs);
        Assert.Empty(updates.Packages);
        Assert.Equal("apt", updates.PackageManager);
    }

    [Fact]
    public async Task Checking_for_updates_refreshes_the_index_then_the_list()
    {
        var job = await FinishedAsync(await _jobs.CheckForUpdatesAsync(_maria, Cancel));

        var updates = _updates.Current;
        Assert.Equal(JobState.Succeeded, job.State);
        Assert.Equal(JobKind.PackagesRefresh, job.Kind);
        Assert.Equal(["packages.refresh"], _mutations.Entries);
        Assert.Equal(2, updates.Packages.Length);
        Assert.Equal(1, updates.SecurityCount);
        Assert.Equal(_clock.GetUtcNow().ToUnixTimeMilliseconds(), updates.CheckedAtUnixMs);
        Assert.False(updates.RebootRequired);
    }

    [Fact]
    public async Task A_failed_listing_keeps_the_last_list_and_says_why()
    {
        await _updates.RefreshAsync(Cancel);
        _packages.ListFailure = new InvalidOperationException("dnf check-update failed: Failed to download metadata");

        var updates = await _updates.RefreshAsync(Cancel);

        Assert.Equal(2, updates.Packages.Length);
        Assert.Contains("Failed to download metadata", updates.Error, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(false, JobKind.PackagesUpgrade, "packages.upgrade", 0)]
    [InlineData(true, JobKind.PackagesUpgradeSecurity, "packages.upgrade-security", 1)]
    public async Task An_upgrade_runs_as_a_job_and_the_list_is_fresh_afterwards(bool securityOnly, JobKind kind, string mutation, int left)
    {
        var job = await FinishedAsync(await _jobs.UpgradeAsync(securityOnly, _maria, Cancel));

        Assert.Equal(JobState.Succeeded, job.State);
        Assert.Equal(kind, job.Kind);
        Assert.Equal("maria", job.RequestedBy);
        Assert.Equal([mutation], _mutations.Entries);
        Assert.Equal(left, _updates.Current.Packages.Length);
    }

    [Fact]
    public async Task Two_package_jobs_never_run_at_once_and_a_reboot_waits_for_them()
    {
        _packages.UpgradeGate = new TaskCompletionSource();
        var upgrade = await _jobs.UpgradeAsync(securityOnly: false, _maria, Cancel);

        await Assert.ThrowsAsync<JobConflictException>(() => _jobs.UpgradeAsync(securityOnly: true, _maria, Cancel));
        await Assert.ThrowsAsync<JobConflictException>(() => _jobs.RebootAsync(_maria, Cancel));
        await Assert.ThrowsAsync<JobConflictException>(() => _jobs.SetAutomaticUpdatesAsync(true, _maria, Cancel));
        _packages.UpgradeGate.SetResult();

        Assert.Equal(JobState.Succeeded, (await FinishedAsync(upgrade)).State);
    }

    [Fact]
    public async Task Cancelling_an_upgrade_leaves_it_cancelled_and_the_list_refreshed()
    {
        _packages.UpgradeGate = new TaskCompletionSource();
        var upgrade = await _jobs.UpgradeAsync(securityOnly: false, _maria, Cancel);

        Assert.True(_engine.Cancel(upgrade.Id));

        Assert.Equal(JobState.Cancelled, (await FinishedAsync(upgrade)).State);
        Assert.NotNull(_updates.Current.CheckedAtUnixMs);
    }

    [Fact]
    public async Task A_reboot_is_scheduled_and_the_job_has_succeeded_before_it_happens()
    {
        var reboot = await FinishedAsync(await _jobs.RebootAsync(_maria, Cancel));

        Assert.Equal(JobState.Succeeded, reboot.State);
        Assert.Equal(JobKind.Reboot, reboot.Kind);
        Assert.False(reboot.Cancellable);
        Assert.Equal(["power.reboot-in=5s"], _mutations.Entries);
    }

    [Fact]
    public async Task Automatic_security_updates_are_switched_by_a_job()
    {
        var job = await FinishedAsync(await _jobs.SetAutomaticUpdatesAsync(true, _maria, Cancel));

        Assert.Equal(JobState.Succeeded, job.State);
        Assert.Equal(["packages.automatic=True"], _mutations.Entries);
        Assert.True(_updates.Current.AutomaticSecurityUpdates.Enabled);
    }

    [Fact]
    public async Task Docker_restarts_as_a_job_that_names_it()
    {
        var job = await FinishedAsync(await _jobs.RestartAsync(ManagedService.Docker, _maria, Cancel));

        Assert.Equal(JobState.Succeeded, job.State);
        Assert.Equal("docker", job.Resource);
        Assert.Equal(["service.restart=docker.service"], _mutations.Entries);
    }

    [Fact]
    public async Task A_service_that_is_not_installed_fails_the_restart_job()
    {
        var job = await FinishedAsync(await _jobs.RestartAsync(ManagedService.Nginx, _maria, Cancel));

        Assert.Equal(JobState.Failed, job.State);
        Assert.Contains("not installed", job.Error, StringComparison.Ordinal);
        Assert.Empty(_mutations.Entries);
    }

    [Fact]
    public async Task Unknown_services_are_refused_before_any_job_starts()
    {
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => _jobs.RestartAsync((ManagedService)42, _maria, Cancel));
        Assert.Empty((await _engine.ListAsync(new JobQuery(), Cancel)).Jobs);
    }
}
