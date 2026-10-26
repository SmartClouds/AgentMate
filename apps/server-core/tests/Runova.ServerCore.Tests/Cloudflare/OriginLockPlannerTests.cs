using System.Net;
using Runova.ServerCore.Cloudflare;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Firewall;
using static Runova.ServerCore.Tests.FirewallTestData;

namespace Runova.ServerCore.Tests.Cloudflare;

/// <summary>
/// E14 AC3 in the planner: with the lock on, ports 80 and 443 are allowed from exactly
/// Cloudflare's IPv4 and IPv6 ranges and from nowhere else, planning again changes nothing, and
/// turning it off opens the ports to everyone again.
/// </summary>
public sealed class OriginLockPlannerTests
{
    private static readonly CloudflareRanges _ranges = CloudflareRangeList.Parse(["173.245.48.0/20", "103.21.244.0/22"], ["2400:cb00::/32"], 0);

    private static FirewallState Open() => Ufw(rules: [Rule(FirewallAction.Allow, 22), Rule(FirewallAction.Allow, 80), Rule(FirewallAction.Allow, 443)]);

    private static FirewallState Applied(FirewallState state, OriginLockPlan plan) =>
        plan.Changes.Count == 0 ? state : FirewallChangePlanner.Plan(state, plan.Changes).Result;

    private static bool Reaches(FirewallState state, string address, int port) =>
        FirewallEvaluation.Evaluate(state, new Probe(IPAddress.Parse(address), port, FirewallProtocol.Tcp)).Allowed;

    [Fact]
    public void Locking_allows_each_range_on_both_ports_and_removes_the_open_rules()
    {
        var plan = OriginLockPlanner.Plan(Open(), _ranges, enable: true);
        var locked = Applied(Open(), plan);

        Assert.Equal(6, plan.Changes.Count(change => change.Kind == FirewallChangeKind.AddRule));
        Assert.Equal(2, plan.Changes.Count(change => change.Kind == FirewallChangeKind.RemoveRule));
        Assert.All(plan.Changes.Where(change => change.Rule is not null), change => Assert.Equal(OriginLockPlanner.Comment, change.Rule!.Comment));
        foreach (var port in new[] { 80, 443 })
        {
            Assert.True(Reaches(locked, "173.245.48.10", port));
            Assert.True(Reaches(locked, "103.21.244.1", port));
            Assert.True(Reaches(locked, "2400:cb00::1", port));
            Assert.False(Reaches(locked, "198.51.100.7", port));
            Assert.False(Reaches(locked, "2001:db8:1::1", port));
        }

        Assert.True(Reaches(locked, App.ToString(), 22));
        Assert.True(OriginLockPlanner.Compare(locked, _ranges).Matches);
    }

    [Fact]
    public void Planning_again_once_locked_changes_nothing()
    {
        var locked = Applied(Open(), OriginLockPlanner.Plan(Open(), _ranges, enable: true));

        Assert.Empty(OriginLockPlanner.Plan(locked, _ranges, enable: true).Changes);
    }

    [Fact]
    public void The_comparison_names_what_is_missing_and_what_is_still_open()
    {
        var comparison = OriginLockPlanner.Compare(Open(), _ranges);

        Assert.False(comparison.Matches);
        Assert.Contains("Allow 443/tcp from 2400:cb00::/32", comparison.Missing);
        Assert.Equal(6, comparison.Missing.Count);
        Assert.Equal(2, comparison.Open.Count);
        Assert.Empty(comparison.Stale);
    }

    [Fact]
    public void A_range_cloudflare_dropped_is_stale_and_removed_while_a_new_one_is_added()
    {
        var locked = Applied(Open(), OriginLockPlanner.Plan(Open(), _ranges, enable: true));
        var moved = CloudflareRangeList.Parse(["173.245.48.0/20", "131.0.72.0/22"], ["2400:cb00::/32"], 0);

        var comparison = OriginLockPlanner.Compare(locked, moved);
        var plan = OriginLockPlanner.Plan(locked, moved, enable: true, previous: [.. CloudflareRangeList.All(_ranges)]);
        var after = Applied(locked, plan);

        Assert.Equal(2, comparison.Stale.Count);
        Assert.Equal(["Allow 443/tcp from 131.0.72.0/22", "Allow 80/tcp from 131.0.72.0/22"], comparison.Missing.Order(StringComparer.Ordinal));
        Assert.True(OriginLockPlanner.Compare(after, moved).Matches);
        Assert.False(Reaches(after, "103.21.244.1", 443));
        Assert.True(Reaches(after, "131.0.72.5", 443));
    }

    [Fact]
    public void Firewalld_keeps_no_comments_so_earlier_ranges_tell_the_lock_rules_apart()
    {
        var state = Firewalld(rules: [Rule(FirewallAction.Allow, 22, shape: "port"), Rule(FirewallAction.Allow, 443, source: "103.21.244.0/22", shape: "rich")]);
        var moved = CloudflareRangeList.Parse(["173.245.48.0/20"], ["2400:cb00::/32"], 0);

        var plan = OriginLockPlanner.Plan(state, moved, enable: true, previous: ["103.21.244.0/22"]);

        Assert.Contains(plan.Changes, change => change.Kind == FirewallChangeKind.RemoveRule && change.RuleId == state.Rules[1].Id);
    }

    [Fact]
    public void A_rule_the_core_cannot_change_is_named_instead_of_removed()
    {
        var state = Ufw(rules: [Rule(FirewallAction.Allow, 22), Rule(FirewallAction.Allow, 80, portTo: 90), Rule(FirewallAction.Allow, 443) with { ReadOnlyReason = "it was made by hand" }]);

        var plan = OriginLockPlanner.Plan(state, _ranges, enable: true);

        Assert.DoesNotContain(plan.Changes, change => change.Kind == FirewallChangeKind.RemoveRule);
        Assert.Equal(2, plan.Notes.Count);
        Assert.Contains(plan.Notes, note => note.Contains("covers other ports too", StringComparison.Ordinal));
        Assert.Contains(plan.Notes, note => note.Contains("it was made by hand", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData(false, FirewallPolicy.Deny, "The firewall is off")]
    [InlineData(true, FirewallPolicy.Allow, "lets every connection in")]
    public void A_firewall_that_lets_everyone_in_anyway_is_refused(bool active, FirewallPolicy incoming, string reason)
    {
        var refused = Assert.Throws<FirewallRefusedException>(() => OriginLockPlanner.Plan(Ufw(active, incoming, Rule(FirewallAction.Allow, 22)), _ranges, enable: true));

        Assert.Contains(reason, refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Unlocking_removes_the_cloudflare_rules_and_opens_both_ports_to_everyone()
    {
        var locked = Applied(Open(), OriginLockPlanner.Plan(Open(), _ranges, enable: true));

        var plan = OriginLockPlanner.Plan(locked, _ranges, enable: false);
        var open = Applied(locked, plan);

        Assert.Equal(6, plan.Changes.Count(change => change.Kind == FirewallChangeKind.RemoveRule));
        Assert.True(Reaches(open, "198.51.100.7", 80));
        Assert.True(Reaches(open, "2001:db8:1::1", 443));
        Assert.DoesNotContain(open.Rules, rule => rule.Source is not null);
        Assert.Empty(OriginLockPlanner.Plan(open, _ranges, enable: false).Changes);
    }

    [Fact]
    public void The_published_ranges_fit_in_one_change_set()
    {
        var plan = OriginLockPlanner.Plan(Open(), CloudflareRecordings.Ranges, enable: true);

        Assert.Equal(46, plan.Changes.Count);
        Assert.True(OriginLockPlanner.Compare(Applied(Open(), plan), CloudflareRecordings.Ranges).Matches);
    }
}
