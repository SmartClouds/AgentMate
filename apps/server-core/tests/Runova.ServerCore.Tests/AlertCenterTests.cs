using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using Runova.ServerCore.Alerts;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Tests;

/// <summary>
/// Alerts: one per condition and resource while it lasts, resolved when it clears, quieted by an
/// acknowledgment. Every change gets a revision higher than any before, so the app's watcher can
/// pick up exactly where it left off, and messages are redacted before they are stored.
/// </summary>
public sealed class AlertCenterTests : IAsyncLifetime
{
    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private readonly FakeTimeProvider _clock = new(DateTimeOffset.FromUnixTimeMilliseconds(1_800_000_000_000));

    private TestDatabase _database = null!;

    private AlertCenter _alerts = null!;

    public async ValueTask InitializeAsync()
    {
        _database = await TestDatabase.CreateAsync();
        _alerts = new AlertCenter(_database.Contexts, _clock, new Redactor(), NullLogger<AlertCenter>.Instance);
    }

    public async ValueTask DisposeAsync() => await _database.DisposeAsync();

    [Fact]
    public async Task The_same_condition_again_updates_the_open_alert()
    {
        var first = await _alerts.RaiseAsync(AlertKind.DiskPressure, "/", AlertSeverity.Warning, "/ is 91% full", Cancel);
        _clock.Advance(TimeSpan.FromMinutes(1));
        var again = await _alerts.RaiseAsync(AlertKind.DiskPressure, "/", AlertSeverity.Warning, "/ is 92% full", Cancel);

        Assert.Equal(first.Id, again.Id);
        Assert.Equal(2, again.Occurrences);
        Assert.Equal("/ is 92% full", again.Message);
        Assert.Equal(first.FirstSeenAtUnixMs, again.FirstSeenAtUnixMs);
        Assert.Equal(first.LastSeenAtUnixMs + 60_000, again.LastSeenAtUnixMs);
        Assert.True(again.Revision > first.Revision);
        Assert.Single(await _alerts.ListAsync(new AlertQuery(), Cancel));
    }

    [Fact]
    public async Task A_cleared_condition_resolves_and_a_new_one_opens_a_fresh_alert()
    {
        var first = await _alerts.RaiseAsync(AlertKind.RebootRequired, "system", AlertSeverity.Warning, "A reboot is needed", Cancel);

        var resolved = await _alerts.ResolveAsync(AlertKind.RebootRequired, "system", Cancel);
        var nothingOpen = await _alerts.ResolveAsync(AlertKind.RebootRequired, "system", Cancel);
        var second = await _alerts.RaiseAsync(AlertKind.RebootRequired, "system", AlertSeverity.Warning, "A reboot is needed", Cancel);

        Assert.NotNull(resolved?.ResolvedAtUnixMs);
        Assert.Null(nothingOpen);
        Assert.NotEqual(first.Id, second.Id);
        Assert.Equal([second.Id], (await _alerts.ListAsync(new AlertQuery(), Cancel)).Select(a => a.Id));
        Assert.Equal(2, (await _alerts.ListAsync(new AlertQuery(IncludeResolved: true), Cancel)).Length);
    }

    [Fact]
    public async Task An_acknowledgment_records_who_and_is_cleared_when_it_gets_worse()
    {
        var raised = await _alerts.RaiseAsync(AlertKind.DiskPressure, "/", AlertSeverity.Warning, "/ is 91% full", Cancel);
        var userId = Guid.NewGuid();

        var acknowledged = await _alerts.AcknowledgeAsync(raised.Id, userId, "maria", Cancel);
        var sameAgain = await _alerts.RaiseAsync(AlertKind.DiskPressure, "/", AlertSeverity.Warning, "/ is 92% full", Cancel);
        var worse = await _alerts.RaiseAsync(AlertKind.DiskPressure, "/", AlertSeverity.Critical, "/ is 96% full", Cancel);

        Assert.Equal("maria", acknowledged!.AcknowledgedBy);
        Assert.NotNull(acknowledged.AcknowledgedAtUnixMs);
        Assert.NotNull(sameAgain.AcknowledgedAtUnixMs);
        Assert.Null(worse.AcknowledgedAtUnixMs);
        Assert.Equal(AlertSeverity.Critical, worse.Severity);
    }

    [Fact]
    public async Task Acknowledging_an_alert_that_does_not_exist_changes_nothing()
    {
        Assert.Null(await _alerts.AcknowledgeAsync(12345, Guid.NewGuid(), "maria", Cancel));
    }

    [Fact]
    public async Task Changes_after_a_revision_are_replayed_in_order()
    {
        var disk = await _alerts.RaiseAsync(AlertKind.DiskPressure, "/", AlertSeverity.Warning, "full", Cancel);
        var reboot = await _alerts.RaiseAsync(AlertKind.RebootRequired, "system", AlertSeverity.Warning, "reboot", Cancel);
        await _alerts.ResolveAsync(AlertKind.DiskPressure, "/", Cancel);

        var all = await _alerts.ChangesAfterAsync(null, 100, Cancel);
        var later = await _alerts.ChangesAfterAsync(reboot.Revision, 100, Cancel);

        // Without a revision: what is open now. After one: every change since, resolutions included.
        Assert.Equal([reboot.Id], all.Select(a => a.Id));
        var resolution = Assert.Single(later);
        Assert.Equal(disk.Id, resolution.Id);
        Assert.NotNull(resolution.ResolvedAtUnixMs);
    }

    [Fact]
    public async Task Subscribers_hear_every_change_as_it_happens()
    {
        using var subscription = _alerts.Subscribe();

        var raised = await _alerts.RaiseAsync(AlertKind.JobFailed, "packagesUpgrade", AlertSeverity.Warning, "failed", Cancel);
        await _alerts.AcknowledgeAsync(raised.Id, Guid.NewGuid(), "maria", Cancel);

        var heard = new List<AlertInfo>();
        for (var i = 0; i < 2; i++)
        {
            heard.Add(await subscription.Reader.ReadAsync(Cancel));
        }

        Assert.Equal([raised.Revision, raised.Revision + 1], heard.Select(a => a.Revision));
    }

    [Fact]
    public async Task A_subscriber_that_falls_behind_is_let_go_so_it_can_subscribe_again()
    {
        using var subscription = _alerts.Subscribe();

        for (var i = 0; i <= AlertCenter.SubscriberBuffer; i++)
        {
            await _alerts.RaiseAsync(AlertKind.DiskPressure, $"/mnt/{i}", AlertSeverity.Warning, "full", Cancel);
        }

        var received = 0;
        await foreach (var _ in subscription.Reader.ReadAllAsync(Cancel))
        {
            received++;
        }

        // The stream ended by itself instead of growing without bound.
        Assert.Equal(AlertCenter.SubscriberBuffer, received);
    }

    [Fact]
    public async Task Revisions_are_never_shared_even_when_changes_race()
    {
        var raised = await Task.WhenAll(Enumerable.Range(0, 20).Select(i =>
            _alerts.RaiseAsync(AlertKind.DiskPressure, $"/mnt/{i}", AlertSeverity.Warning, "full", Cancel)));

        Assert.Equal(20, raised.Select(a => a.Revision).Distinct().Count());
    }

    [Fact]
    public async Task Messages_are_redacted_before_they_are_stored()
    {
        var raised = await _alerts.RaiseAsync(
            AlertKind.JobFailed,
            "packagesUpgrade",
            AlertSeverity.Warning,
            "apt failed: fetch https://deploy:tok3n-value@repo.example.com",
            Cancel);

        Assert.DoesNotContain("tok3n-value", raised.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("tok3n-value", (await _alerts.ListAsync(new AlertQuery(), Cancel))[0].Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Old_resolved_alerts_are_pruned_and_open_ones_are_kept()
    {
        await _alerts.RaiseAsync(AlertKind.DiskPressure, "/", AlertSeverity.Warning, "full", Cancel);
        await _alerts.ResolveAsync(AlertKind.DiskPressure, "/", Cancel);
        await _alerts.RaiseAsync(AlertKind.RebootRequired, "system", AlertSeverity.Warning, "reboot", Cancel);
        _clock.Advance(TimeSpan.FromDays(40));

        var pruned = await _alerts.PruneAsync(_clock.GetUtcNow() - AlertCenter.KeepResolved, Cancel);

        Assert.Equal(1, pruned);
        Assert.Single(await _alerts.ListAsync(new AlertQuery(IncludeResolved: true), Cancel));
    }

    [Fact]
    public async Task The_latest_revision_is_zero_at_first_then_the_highest_change()
    {
        Assert.Equal(0, await _alerts.LatestRevisionAsync(Cancel));

        await _alerts.RaiseAsync(AlertKind.DiskPressure, "/", AlertSeverity.Warning, "full", Cancel);
        var resolved = await _alerts.ResolveAsync(AlertKind.DiskPressure, "/", Cancel);

        Assert.Equal(resolved!.Revision, await _alerts.LatestRevisionAsync(Cancel));
    }
}
