using System.Net;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Runova.ServerCore.Cloudflare;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Firewall;
using Runova.ServerCore.Nginx;
using Runova.ServerCore.Security;
using Runova.ServerCore.Tests.Web;

namespace Runova.ServerCore.Tests.Cloudflare;

/// <summary>
/// E14 T6 and AC3 through the hub: locking the origin is a firewall change set that waits for its
/// confirmation, after which the firewall allows 80 and 443 from exactly the fetched IPv4 and IPv6
/// ranges and nginx restores the visitor's address; the daily refresh follows Cloudflare's list
/// by itself; and unlocking opens the ports again.
/// </summary>
public sealed class HubOriginLockTests
{
    private static readonly CloudflareRanges _small = CloudflareRangeList.Parse(["173.245.48.0/20", "103.21.244.0/22"], ["2400:cb00::/32"], 0);

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private static async Task<(AuthHarness Harness, HubConnection Hub)> StartAsync(string role = CoreRoles.Admin)
    {
        var harness = await AuthHarness.CreateAsync(role);
        harness.Services.GetRequiredService<FakeCloudflareApi>().Ranges = _small;
        var hub = await WebHubTests.ConnectAsync(harness);
        if (role == CoreRoles.Admin)
        {
            await WebHubTests.SetUpNginxAsync(harness, hub);
            Assert.Empty((await hub.InvokeAsync<SiteSaveResult>(nameof(ICoreHub.SaveSite), WebHubTests.Blog(), Cancel)).Problems);
        }

        return (harness, hub);
    }

    private static Task<OriginLockResult> LockAsync(HubConnection hub, bool enabled = true, bool pulls = false) =>
        hub.InvokeAsync<OriginLockResult>(nameof(ICoreHub.ApplyOriginLock), new OriginLockRequest(enabled, pulls), Cancel);

    /// <summary>Confirms over a new connection, as the app does over a new SSH login.</summary>
    private static async Task ConfirmAsync(AuthHarness harness, Guid changeSetId)
    {
        await using var fresh = await WebHubTests.ConnectAsync(harness);
        var confirmed = await fresh.InvokeAsync<FirewallChangeSetInfo>(nameof(ICoreHub.ConfirmFirewallChanges), changeSetId, Cancel);
        Assert.Equal(FirewallChangeState.Confirmed, confirmed.State);
    }

    private static bool Reaches(AuthHarness harness, string address, int port) =>
        FirewallEvaluation.Evaluate(harness.Services.GetRequiredService<FakeFirewallBackend>().State, new Probe(IPAddress.Parse(address), port, FirewallProtocol.Tcp)).Allowed;

    private static string Nginx(AuthHarness harness, string path) =>
        harness.Services.GetRequiredService<SimulatedNginxMachine>().Text($"/etc/nginx/runova/current/{path}") ?? string.Empty;

    [Fact]
    public async Task Locking_waits_for_confirmation_then_the_firewall_matches_the_fetched_ranges_for_both_families()
    {
        var (harness, hub) = await StartAsync();
        await using var _ = harness;
        await using var __ = hub;

        var preview = await hub.InvokeAsync<OriginLockPreview>(nameof(ICoreHub.PreviewOriginLock), new OriginLockRequest(true), Cancel);
        var result = await LockAsync(hub, pulls: true);

        Assert.Equal(6, preview.Changes.Length);
        Assert.False(preview.Firewall!.Guard.Blocked);
        Assert.Equal(_small.Ipv6, preview.Ranges.Ipv6);
        Assert.Equal(OriginLockState.Pending, result.Status.State);
        Assert.Equal(FirewallChangeState.AwaitingConfirmation, result.ChangeSet!.State);
        Assert.True(result.Nginx.Applied, result.Nginx.Error);

        await ConfirmAsync(harness, result.ChangeSet.Id);
        var status = await hub.InvokeAsync<OriginLockStatus>(nameof(ICoreHub.GetOriginLock), Cancel);

        Assert.Equal(OriginLockState.On, status.State);
        Assert.True(status.AuthenticatedOriginPulls);
        Assert.Empty(status.MissingRules);
        Assert.Empty(status.OpenRules);
        Assert.Empty(status.StaleRules);
        foreach (var port in new[] { 80, 443 })
        {
            Assert.True(Reaches(harness, "173.245.48.1", port));
            Assert.True(Reaches(harness, "2400:cb00::7", port));
            Assert.False(Reaches(harness, "198.51.100.9", port));
            Assert.False(Reaches(harness, "2001:db8:9::1", port));
        }

        var realIp = Nginx(harness, NginxCloudflare.RealIpFile);
        Assert.All(CloudflareRangeList.All(_small), range => Assert.Contains($"set_real_ip_from {range};", realIp, StringComparison.Ordinal));
        Assert.Equal(NginxCloudflare.OriginPullCa, Nginx(harness, NginxCloudflare.OriginPullCaFile));
        Assert.Contains("cloudflare/real-ip.conf;", Nginx(harness, "sites/blog.conf"), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Changed_ranges_bring_a_lock_that_is_on_up_to_date_without_a_confirmation()
    {
        var (harness, hub) = await StartAsync();
        await using var _ = harness;
        await using var __ = hub;
        await ConfirmAsync(harness, (await LockAsync(hub)).ChangeSet!.Id);
        var api = harness.Services.GetRequiredService<FakeCloudflareApi>();
        api.Ranges = CloudflareRangeList.Parse(["173.245.48.0/20", "131.0.72.0/22"], ["2400:cb00::/32", "2606:4700::/32"], 0);

        var status = await hub.InvokeAsync<OriginLockStatus>(nameof(ICoreHub.RefreshCloudflareRanges), Cancel);

        Assert.Equal(OriginLockState.On, status.State);
        Assert.Equal(FirewallChangeState.Confirmed, status.ChangeState);
        Assert.Null(status.LastRefreshError);
        Assert.True(Reaches(harness, "131.0.72.9", 443));
        Assert.True(Reaches(harness, "2606:4700::1", 80));
        Assert.False(Reaches(harness, "103.21.244.1", 443));
        Assert.Contains("set_real_ip_from 131.0.72.0/22;", Nginx(harness, NginxCloudflare.RealIpFile), StringComparison.Ordinal);
        Assert.DoesNotContain("103.21.244.0/22", Nginx(harness, NginxCloudflare.RealIpFile), StringComparison.Ordinal);

        await using var scope = harness.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<CoreDbContext>();
        var unattended = await db.FirewallChangeSets.AsNoTracking().OrderByDescending(c => c.CreatedAt).FirstAsync(Cancel);
        Assert.Equal((FirewallChangeState.Confirmed, OriginLockService.RefreshRequester), (unattended.State, unattended.RequestedByName));
    }

    [Fact]
    public async Task A_refresh_that_cannot_reach_cloudflare_keeps_the_rules_and_raises_an_alert()
    {
        var (harness, hub) = await StartAsync();
        await using var _ = harness;
        await using var __ = hub;
        await ConfirmAsync(harness, (await LockAsync(hub)).ChangeSet!.Id);
        harness.Services.GetRequiredService<FakeCloudflareApi>().FetchFailure = new CloudflareApiException("Cloudflare could not be reached: timeout");

        var status = await hub.InvokeAsync<OriginLockStatus>(nameof(ICoreHub.RefreshCloudflareRanges), Cancel);
        var alerts = await hub.InvokeAsync<AlertInfo[]>(nameof(ICoreHub.ListAlerts), new AlertQuery(), Cancel);

        Assert.Equal(OriginLockState.On, status.State);
        Assert.Contains("could not be fetched", status.LastRefreshError, StringComparison.Ordinal);
        Assert.Contains(alerts, alert => alert.Kind == AlertKind.OriginLockRefreshFailed);
        Assert.True(Reaches(harness, "173.245.48.1", 443));
    }

    [Fact]
    public async Task Unlocking_opens_both_ports_to_everyone_and_takes_the_real_ip_out_of_nginx()
    {
        var (harness, hub) = await StartAsync();
        await using var _ = harness;
        await using var __ = hub;
        await ConfirmAsync(harness, (await LockAsync(hub)).ChangeSet!.Id);

        var result = await LockAsync(hub, enabled: false);
        await ConfirmAsync(harness, result.ChangeSet!.Id);

        Assert.Equal(OriginLockState.Off, (await hub.InvokeAsync<OriginLockStatus>(nameof(ICoreHub.GetOriginLock), Cancel)).State);
        Assert.True(Reaches(harness, "198.51.100.9", 443));
        Assert.True(Reaches(harness, "2001:db8:9::1", 80));
        Assert.DoesNotContain("real-ip", Nginx(harness, "sites/blog.conf"), StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_viewer_reads_the_lock_and_cannot_change_it()
    {
        var (harness, hub) = await StartAsync(CoreRoles.Viewer);
        await using var _ = harness;
        await using var __ = hub;

        var status = await hub.InvokeAsync<OriginLockStatus>(nameof(ICoreHub.GetOriginLock), Cancel);
        var refused = await Assert.ThrowsAsync<HubException>(() => LockAsync(hub));
        var refresh = await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync<OriginLockStatus>(nameof(ICoreHub.RefreshCloudflareRanges), Cancel));

        Assert.Equal(OriginLockState.Off, status.State);
        Assert.Contains("unauthorized", refused.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("unauthorized", refresh.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Empty(harness.Services.GetRequiredService<MutationLog>().Entries);
    }

    [Fact]
    public async Task A_firewall_that_is_off_is_refused_with_what_to_do()
    {
        var (harness, hub) = await StartAsync();
        await using var _ = harness;
        await using var __ = hub;
        var backend = harness.Services.GetRequiredService<FakeFirewallBackend>();
        backend.State = backend.State with { Active = false };

        var refused = await Assert.ThrowsAsync<HubException>(() => LockAsync(hub));

        Assert.Contains("Turn it on in the Firewall section first", refused.Message, StringComparison.Ordinal);
    }
}
