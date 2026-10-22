using AgentMate.ServerCore.Backups;
using AgentMate.ServerCore.Cloudflare;
using AgentMate.ServerCore.Contracts;
using AgentMate.ServerCore.Data;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Time.Testing;

namespace AgentMate.ServerCore.Tests.Backups;

/// <summary>
/// Moving a restored server's settings to its new address (E28): each old address maps to a new
/// one of the same family; what names an old one exactly (or as a single-host network) moves.
/// </summary>
public sealed class AddressRebindPlannerTests
{
    private static readonly string[] _old = ["203.0.113.10", "2001:db8::10"];
    private static readonly string[] _new = ["198.51.100.7", "2001:db8::77"];

    [Fact]
    public void Each_old_address_maps_to_a_new_one_of_its_family()
    {
        var map = AddressRebindPlanner.Map(_old, _new);

        Assert.Equal("198.51.100.7", map["203.0.113.10"]);
        Assert.Equal("2001:db8::77", map["2001:db8::10"]);
        Assert.Empty(AddressRebindPlanner.Map(["2001:db8::10"], ["198.51.100.7"]));
    }

    [Theory]
    [InlineData("203.0.113.10", "198.51.100.7")]
    [InlineData("203.0.113.10/32", "198.51.100.7/32")]
    [InlineData("2001:db8::10/128", "2001:db8::77/128")]
    [InlineData("203.0.113.0/24", null)]
    [InlineData("203.0.113.100", null)]
    [InlineData("shop.example.com", null)]
    public void Only_an_exact_address_or_its_single_host_network_moves(string value, string? moved) =>
        Assert.Equal(moved, AddressRebindPlanner.Replace(value, AddressRebindPlanner.Map(_old, _new)));

    [Fact]
    public void The_plan_lists_sites_firewall_rules_cloudflare_records_and_stack_files()
    {
        var map = AddressRebindPlanner.Map(_old, _new);

        var plan = AddressRebindPlanner.Plan(
            map,
            [new("site-1", "203.0.113.10"), new("site-2", "shop.example.com")],
            [new FirewallRuleSpec(FirewallAction.Allow, FirewallProtocol.Tcp, 22, Source: "203.0.113.10/32"), new FirewallRuleSpec(FirewallAction.Allow, FirewallProtocol.Tcp, 443)],
            [new CloudflareAddressRecord("example.com", "a1", "shop.example.com", "A", "203.0.113.10", true)],
            ["shop/compose.yaml"]);

        Assert.Contains(plan, c => c is { Area: "Website", Target: "203.0.113.10", To: "198.51.100.7", Automatic: true });
        Assert.Contains(plan, c => c is { Area: "Firewall rule", From: "203.0.113.10/32", To: "198.51.100.7/32", Automatic: true });
        Assert.Contains(plan, c => c is { Area: "Cloudflare DNS", Target: "shop.example.com", Automatic: true });
        Assert.Contains(plan, c => c is { Area: "Stack file", Target: "shop/compose.yaml", Automatic: false });
        Assert.Equal(4, plan.Count);
    }

    [Fact]
    public void Hostnames_outside_the_cloudflare_zones_are_left_to_the_person()
    {
        var manual = AddressRebindPlanner.ManualDns(
            ["shop.example.com", "blog.example.org", "203.0.113.10", "www.blog.example.org"],
            ["example.com"]);

        Assert.Equal(["blog.example.org", "www.blog.example.org"], manual);
    }

    [Fact]
    public void Firewall_rules_are_rewritten_for_the_app_to_apply()
    {
        var rule = AddressRebindPlanner.Rewrite(new FirewallRuleSpec(FirewallAction.Allow, FirewallProtocol.Tcp, 5432, Source: "203.0.113.10"), AddressRebindPlanner.Map(_old, _new));

        Assert.Equal("198.51.100.7", rule.Source);
        Assert.Equal(5432, rule.Port);
    }
}

/// <summary>Cloudflare records as a fake zone holds them.</summary>
internal sealed class FakeCloudflareRecords : ICloudflareRecords
{
    public List<CloudflareAddressRecord> Records { get; } = [];

    public List<(string Id, string Content)> Updated { get; } = [];

    public Task<IReadOnlyList<CloudflareAddressRecord>> FindAsync(string zone, string zoneId, string token, string content, CancellationToken cancellationToken) =>
        Task.FromResult<IReadOnlyList<CloudflareAddressRecord>>([.. Records.Where(r => r.Zone == zone && r.Content == content)]);

    public Task UpdateAsync(string zoneId, string token, CloudflareAddressRecord record, string content, CancellationToken cancellationToken)
    {
        Updated.Add((record.Id, content));
        return Task.CompletedTask;
    }
}

/// <summary>The rebinder against a database: sites and Cloudflare move, stack files are only named.</summary>
public sealed class AddressRebinderTests : IAsyncLifetime
{
    private readonly FakeCloudflareRecords _cloudflare = new();
    private TestDatabase _database = null!;
    private AddressRebinder _rebinder = null!;

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        _database = await TestDatabase.CreateAsync();
        var protection = new EphemeralDataProtectionProvider();
        var credentials = new DnsCredentials(_database.Contexts, protection, new AcceptingDnsApi(), new FakeTimeProvider());
        _rebinder = new AddressRebinder(_database.Contexts, credentials, _cloudflare, new Hosting.CoreDirectories(_database.Directory));
        await credentials.SaveAsync(new DnsCredentialRequest("example.com", new string('a', 32), "cf-token-0123456789abcdef0123456789", null), new Updates.Requester(Guid.NewGuid(), "maria"), Cancel);
        await using var db = await _database.Contexts.CreateDbContextAsync(Cancel);
        db.Sites.Add(new Site { Id = "site-1", Settings = "{}" });
        db.SiteDomains.Add(new SiteDomain { SiteId = "site-1", Domain = "203.0.113.10" });
        db.Sites.Add(new Site { Id = "site-2", Settings = "{}" });
        db.SiteDomains.Add(new SiteDomain { SiteId = "site-2", Domain = "shop.example.com" });
        db.SiteDomains.Add(new SiteDomain { SiteId = "site-2", Domain = "blog.example.org", Position = 1 });
        await db.SaveChangesAsync(Cancel);
        _cloudflare.Records.Add(new CloudflareAddressRecord("example.com", "r1", "shop.example.com", "A", "203.0.113.10", true));
        Directory.CreateDirectory(Path.Combine(_database.Directory, "stacks", "shop"));
        await File.WriteAllTextAsync(Path.Combine(_database.Directory, "stacks", "shop", ".env"), "PUBLIC_IP=203.0.113.10\n", Cancel);
    }

    public async ValueTask DisposeAsync() => await _database.DisposeAsync();

    [Fact]
    public async Task Sites_and_cloudflare_records_move_and_the_rest_is_reported()
    {
        var plan = await _rebinder.PlanAsync(["203.0.113.10"], ["198.51.100.7"], Cancel);
        var moved = await _rebinder.ApplyAsync(["203.0.113.10"], ["198.51.100.7"], Cancel);

        Assert.Equal(plan.Count, moved.Applied.Count);
        Assert.Equal([("r1", "198.51.100.7")], _cloudflare.Updated);
        Assert.Equal(["blog.example.org"], moved.ManualDns);
        Assert.Contains(moved.Applied, c => c is { Area: "Stack file", Automatic: false });
        await using var db = await _database.Contexts.CreateDbContextAsync(Cancel);
        Assert.Equal("198.51.100.7", (await db.SiteDomains.SingleAsync(d => d.SiteId == "site-1", Cancel)).Domain);
        Assert.Equal("PUBLIC_IP=203.0.113.10\n", await File.ReadAllTextAsync(Path.Combine(_database.Directory, "stacks", "shop", ".env"), Cancel));
    }

    private sealed class AcceptingDnsApi : ICloudflareDnsApi
    {
        public Task<string?> CheckAsync(string zoneId, string token, CancellationToken cancellationToken) => Task.FromResult<string?>(null);

        public Task<string> CreateTxtAsync(string zoneId, string token, string name, string content, CancellationToken cancellationToken) => Task.FromResult("id");

        public Task<IReadOnlyList<CloudflareTxtRecord>> FindTxtAsync(string zoneId, string token, string name, CancellationToken cancellationToken) =>
            Task.FromResult<IReadOnlyList<CloudflareTxtRecord>>([]);

        public Task DeleteAsync(string zoneId, string token, string recordId, CancellationToken cancellationToken) => Task.CompletedTask;
    }
}
