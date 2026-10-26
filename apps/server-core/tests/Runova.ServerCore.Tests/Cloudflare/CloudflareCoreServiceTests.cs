using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Runova.ServerCore.Certificates.Acme;
using Runova.ServerCore.Cloudflare;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Firewall;
using Runova.ServerCore.Security;
using Runova.ServerCore.Updates;
using static Runova.ServerCore.Tests.FirewallTestData;

namespace Runova.ServerCore.Tests.Cloudflare;

/// <summary>
/// The parts of E14 behind the hub: what the core may change in the firewall by itself, which
/// zone's token a name uses, cleaning up a DNS-01 record after a restart, and the daily refresh.
/// </summary>
public sealed class CloudflareCoreServiceTests
{
    private const string ZoneId = "023e105f4ecef8ad9ca31a8372d0c353";
    private const string SubZoneId = "9a7806061c88ada191ed06f989cc3dac";
    private const string Token = "Gm4pR2e6Tq9VxYb1Lk0NsHjW3cZaDf7U8iOoPl5M";

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private static readonly Requester _maria = new(Guid.NewGuid(), "maria");

    [Theory]
    [InlineData(22)]
    [InlineData(8080)]
    public async Task The_core_alone_only_adds_allow_rules_for_the_ports_it_was_given(int port)
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Admin);
        var manager = harness.Services.GetRequiredService<FirewallManager>();

        var refused = await Assert.ThrowsAsync<FirewallRefusedException>(() => manager.ApplyUnattendedAsync(
            [new FirewallChange(FirewallChangeKind.AddRule, new FirewallRuleSpec(FirewallAction.Allow, FirewallProtocol.Tcp, port, Source: "173.245.48.0/20"))],
            "test",
            OriginLockPlanner.Ports,
            Cancel));
        var removeSsh = await Assert.ThrowsAsync<FirewallRefusedException>(() => manager.ApplyUnattendedAsync(
            [new FirewallChange(FirewallChangeKind.RemoveRule, RuleId: harness.Services.GetRequiredService<FakeFirewallBackend>().State.Rules[0].Id)],
            "test",
            OriginLockPlanner.Ports,
            Cancel));
        var disable = await Assert.ThrowsAsync<FirewallRefusedException>(() => manager.ApplyUnattendedAsync(
            [new FirewallChange(FirewallChangeKind.Disable)], "test", OriginLockPlanner.Ports, Cancel));

        Assert.Contains("only changes allow rules for ports 80, 443", refused.Message, StringComparison.Ordinal);
        Assert.Contains("only changes allow rules", removeSsh.Message, StringComparison.Ordinal);
        Assert.Contains("only changes allow rules", disable.Message, StringComparison.Ordinal);
        Assert.Empty(harness.Services.GetRequiredService<MutationLog>().Entries);
    }

    [Fact]
    public async Task An_unattended_change_is_saved_first_and_recorded_as_confirmed_by_the_core()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Admin);
        var manager = harness.Services.GetRequiredService<FirewallManager>();

        var change = await manager.ApplyUnattendedAsync(
            [new FirewallChange(FirewallChangeKind.AddRule, new FirewallRuleSpec(FirewallAction.Allow, FirewallProtocol.Tcp, 443, Source: "173.245.48.0/20"))],
            "the origin lock's daily refresh",
            OriginLockPlanner.Ports,
            Cancel);

        Assert.Equal((FirewallChangeState.Confirmed, "the origin lock's daily refresh"), (change.State, change.RequestedBy));
        Assert.Null(change.DeadlineUnixMs);
        Assert.Equal(["firewall.apply=Allow 443/tcp from 173.245.48.0/20"], harness.Services.GetRequiredService<MutationLog>().Entries);
    }

    [Fact]
    public async Task A_name_uses_the_token_of_the_longest_zone_it_belongs_to()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Admin);
        var credentials = harness.Services.GetRequiredService<DnsCredentials>();
        Assert.Empty((await credentials.SaveAsync(new DnsCredentialRequest("example.com", ZoneId, Token), _maria, Cancel)).Problems);
        Assert.Empty((await credentials.SaveAsync(new DnsCredentialRequest("dev.example.com", SubZoneId, Token + "x"), _maria, Cancel)).Problems);

        Assert.Equal(ZoneId, (await credentials.ForDomainAsync("www.example.com", Cancel))?.ZoneId);
        Assert.Equal(SubZoneId, (await credentials.ForDomainAsync("*.api.dev.example.com", Cancel))?.ZoneId);
        Assert.Equal(Token + "x", (await credentials.ForDomainAsync("dev.example.com", Cancel))?.Token);
        Assert.Null(await credentials.ForDomainAsync("notexample.com", Cancel));
        Assert.Null(await credentials.ForDomainAsync("example.org", Cancel));
    }

    [Fact]
    public async Task A_record_left_by_a_restarted_core_is_found_by_name_and_value_and_removed()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Admin);
        var credentials = harness.Services.GetRequiredService<DnsCredentials>();
        await credentials.SaveAsync(new DnsCredentialRequest("example.com", ZoneId, Token), _maria, Cancel);
        var api = harness.Services.GetRequiredService<FakeCloudflareApi>();
        api.AddRecord("_acme-challenge.example.com", "left-over");
        api.AddRecord("_acme-challenge.example.com", "someone-elses");
        var hook = new CloudflareDns01Hook(credentials, api, new CloudflareDns01Options(TimeSpan.Zero), TimeProvider.System, NullLogger<CloudflareDns01Hook>.Instance);

        await hook.RemoveAsync("example.com", "_acme-challenge.example.com", "left-over", Cancel);

        Assert.Equal(["someone-elses"], api.Records.Select(record => record.Content));
    }

    [Fact]
    public async Task A_token_cloudflare_refuses_mid_issuance_is_recorded_on_the_zone()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Admin);
        var credentials = harness.Services.GetRequiredService<DnsCredentials>();
        await credentials.SaveAsync(new DnsCredentialRequest("example.com", ZoneId, Token), _maria, Cancel);
        harness.Services.GetRequiredService<FakeCloudflareApi>().RefuseCreates = true;
        var hook = harness.Services.GetRequiredService<CloudflareDns01Hook>();

        var refused = await Assert.ThrowsAsync<AcmeException>(() => hook.PublishAsync("example.com", "_acme-challenge.example.com", "v", Cancel));

        Assert.Contains("send a new one from the Cloudflare page", refused.Message, StringComparison.Ordinal);
        Assert.Contains("Authentication error", Assert.Single(await credentials.ListAsync(Cancel)).LastError, StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_ranges_are_fetched_a_while_after_start_and_then_every_day()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Admin, fakeClock: true, (services, _) =>
            services.AddSingleton(OriginLockOptions.Default));
        var api = harness.Services.GetRequiredService<FakeCloudflareApi>();
        var clock = harness.Clock!;

        Assert.Equal(0, api.Fetches);
        await WaitForAsync(() => { clock.Advance(TimeSpan.FromMinutes(1)); return api.Fetches == 1; });
        await WaitForAsync(() => { clock.Advance(TimeSpan.FromHours(6)); return api.Fetches == 2; });
        var status = await harness.Services.GetRequiredService<OriginLockService>().StatusAsync(Cancel);

        Assert.Equal(OriginLockState.Off, status.State);
        Assert.Equal(CloudflareRecordings.Ranges.Ipv4, status.Ranges!.Ipv4);
    }

    private static async Task WaitForAsync(Func<bool> done)
    {
        for (var attempt = 0; attempt < 200; attempt++)
        {
            if (done())
            {
                return;
            }

            await Task.Delay(20, Cancel);
        }

        Assert.Fail("It did not happen in time.");
    }
}
