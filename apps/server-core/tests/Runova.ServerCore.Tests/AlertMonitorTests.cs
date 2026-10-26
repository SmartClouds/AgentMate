using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using Runova.ServerCore.Alerts;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Platform;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Tests;

/// <summary>
/// The checks that raise alerts on their own: a filesystem filling up (warning at 90%, critical at
/// 95%, cleared below 85% so it does not flap) and a reboot that updates are waiting for.
/// </summary>
public sealed class AlertMonitorTests : IAsyncLifetime
{
    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private readonly FakeTimeProvider _clock = new(DateTimeOffset.FromUnixTimeMilliseconds(1_800_000_000_000));
    private readonly FakeSystemProbe _probe = new();
    private readonly FakePackageManager _packages = new(new MutationLog());
    private TestDatabase _database = null!;
    private AlertCenter _alerts = null!;
    private AlertMonitor _monitor = null!;

    public async ValueTask InitializeAsync()
    {
        _database = await TestDatabase.CreateAsync();
        _alerts = new AlertCenter(_database.Contexts, _clock, new Redactor(), NullLogger<AlertCenter>.Instance);
        _monitor = new AlertMonitor(_probe, _packages, _alerts, NullLogger<AlertMonitor>.Instance);
    }

    public async ValueTask DisposeAsync()
    {
        _monitor.Dispose();
        await _database.DisposeAsync();
    }

    private async Task<AlertInfo[]> DiskAlertsAfterAsync(params DiskInfo[] disks)
    {
        _probe.SetFilesystems(disks);
        await _monitor.CheckDisksAsync(Cancel);
        return await _alerts.OpenAsync(AlertKind.DiskPressure, Cancel);
    }

    [Fact]
    public async Task A_filesystem_over_90_percent_raises_a_warning_and_over_95_a_critical()
    {
        var warning = await DiskAlertsAfterAsync(FakeSystemProbe.Disk("/", used: 91, total: 100));
        var critical = await DiskAlertsAfterAsync(FakeSystemProbe.Disk("/", used: 96, total: 100));

        Assert.Equal(AlertSeverity.Warning, Assert.Single(warning).Severity);
        var alert = Assert.Single(critical);
        Assert.Equal(AlertSeverity.Critical, alert.Severity);
        Assert.Equal("/", alert.Resource);
        Assert.Contains("96%", alert.Message, StringComparison.Ordinal);
        Assert.Equal(warning[0].Id, alert.Id);
    }

    [Fact]
    public async Task Disk_pressure_clears_below_85_percent_and_not_before()
    {
        await DiskAlertsAfterAsync(FakeSystemProbe.Disk("/", used: 92, total: 100));

        var stillOpen = await DiskAlertsAfterAsync(FakeSystemProbe.Disk("/", used: 87, total: 100));
        var cleared = await DiskAlertsAfterAsync(FakeSystemProbe.Disk("/", used: 80, total: 100));

        Assert.Single(stillOpen);
        Assert.Empty(cleared);
    }

    [Fact]
    public async Task Checking_again_without_a_change_does_not_touch_the_alert()
    {
        var first = await DiskAlertsAfterAsync(FakeSystemProbe.Disk("/", used: 91, total: 100));
        var again = await DiskAlertsAfterAsync(FakeSystemProbe.Disk("/", used: 91, total: 100));

        Assert.Equal(first[0].Revision, again[0].Revision);
    }

    [Fact]
    public async Task A_filesystem_that_went_away_resolves_its_alert()
    {
        await DiskAlertsAfterAsync(FakeSystemProbe.Disk("/", used: 10, total: 100), FakeSystemProbe.Disk("/mnt/data", used: 99, total: 100));

        var after = await DiskAlertsAfterAsync(FakeSystemProbe.Disk("/", used: 10, total: 100));

        Assert.Empty(after);
    }

    [Fact]
    public async Task A_needed_reboot_raises_an_alert_that_clears_after_the_reboot()
    {
        _packages.Reboot = new RebootStatus(true, ["linux-image-6.8.0-47-generic"]);
        await _monitor.CheckRebootAsync(Cancel);
        var raised = await _alerts.OpenAsync(AlertKind.RebootRequired, Cancel);

        _packages.Reboot = new RebootStatus(null, []);
        await _monitor.CheckRebootAsync(Cancel);
        var unknown = await _alerts.OpenAsync(AlertKind.RebootRequired, Cancel);

        _packages.Reboot = new RebootStatus(false, []);
        await _monitor.CheckRebootAsync(Cancel);
        var cleared = await _alerts.OpenAsync(AlertKind.RebootRequired, Cancel);

        var alert = Assert.Single(raised);
        Assert.Equal("system", alert.Resource);
        Assert.Contains("linux-image-6.8.0-47-generic", alert.Message, StringComparison.Ordinal);
        Assert.Single(unknown);
        Assert.Empty(cleared);
    }
}
