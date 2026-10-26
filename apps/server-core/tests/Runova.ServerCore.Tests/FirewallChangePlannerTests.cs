using Runova.ServerCore.Contracts;
using Runova.ServerCore.Firewall;
using static Runova.ServerCore.Tests.FirewallTestData;

namespace Runova.ServerCore.Tests;

/// <summary>
/// A change set is checked once, here, for both backends: every rule is valid, everything it
/// names exists, and the firewall it leaves behind is worked out the way the backend would build
/// it, so the lockout guard judges the real result.
/// </summary>
public sealed class FirewallChangePlannerTests
{
    private static FirewallRefusedException Refused(FirewallState state, params FirewallChange[] changes) =>
        Assert.Throws<FirewallRefusedException>(() => FirewallChangePlanner.Plan(state, changes));

    [Fact]
    public void On_ufw_an_allow_goes_last_and_a_deny_first_so_denies_win()
    {
        var current = Ufw(rules: [Allow(22)]);

        var plan = FirewallChangePlanner.Plan(
            current,
            [Add(Tcp(80)), Add(new FirewallRuleSpec(FirewallAction.Deny, FirewallProtocol.Any, Source: "198.51.100.0/24"))]);

        var order = plan.Result.Rules.OrderBy(rule => rule.Ipv4Order).Select(FirewallEvaluation.Describe).ToList();
        Assert.Equal(
            ["Deny everything from 198.51.100.0/24", "Allow 22/tcp from anywhere", "Allow 80/tcp from anywhere"],
            order);
        Assert.Equal(2, plan.Added.Count);
        Assert.Null(plan.Enable);
        Assert.False(plan.NeedsStepUp);
    }

    [Fact]
    public void A_rule_without_a_source_covers_both_families_and_one_with_a_source_only_its_own()
    {
        var plan = FirewallChangePlanner.Plan(Ufw(), [Add(Tcp(443)), Add(Tcp(5432, "10.0.0.0/8")), Add(Tcp(5432, "2001:db8::/32"))]);

        Assert.Equal(
            [FirewallFamilies.Both, FirewallFamilies.Ipv4, FirewallFamilies.Ipv6],
            plan.Added.Select(rule => rule.Families));
    }

    [Fact]
    public void Firewalld_keeps_an_allow_without_a_source_as_a_port_and_the_rest_as_rich_rules()
    {
        var plan = FirewallChangePlanner.Plan(
            Firewalld(),
            [
                Add(Tcp(8080)),
                Add(Tcp(5432, "10.0.0.0/8")),
                Add(new FirewallRuleSpec(FirewallAction.Allow, FirewallProtocol.Any, 53)),
            ]);

        Assert.Equal(["port", "rich", "port", "port"], plan.Added.Select(rule => rule.Shape));
        // firewalld ports carry one protocol each, so "any" becomes a TCP and a UDP port.
        Assert.Equal(
            [FirewallProtocol.Tcp, FirewallProtocol.Tcp, FirewallProtocol.Tcp, FirewallProtocol.Udp],
            plan.Added.Select(rule => rule.Protocol));
    }

    [Fact]
    public void Adding_a_rule_that_is_already_there_changes_nothing_and_says_so()
    {
        var plan = FirewallChangePlanner.Plan(Ufw(rules: [Allow(22)]), [Add(Tcp(22, comment: "again"))]);

        Assert.Empty(plan.Added);
        Assert.Single(plan.Result.Rules);
        Assert.Contains(plan.Notes, note => note.Contains("already", StringComparison.Ordinal));
    }

    [Fact]
    public void A_rule_is_removed_by_its_id()
    {
        var keep = Allow(80);
        var drop = Allow(8080);

        var plan = FirewallChangePlanner.Plan(Ufw(rules: [keep, drop]), [Remove(drop.Id)]);

        Assert.Equal([keep.Id], plan.Result.Rules.Select(rule => rule.Id));
        Assert.Equal([drop.Id], plan.Removed.Select(rule => rule.Id));
    }

    [Fact]
    public void Removing_a_rule_that_is_gone_or_that_the_core_cannot_change_is_refused()
    {
        var foreign = Allow(8443) with { Interface = "eth0", ReadOnlyReason = "it is limited to one interface" };

        var gone = Refused(Ufw(rules: [Allow(22)]), Remove("0123456789abcdef"));
        var readOnly = Refused(Ufw(rules: [foreign]), Remove(foreign.Id));

        Assert.Contains("no rule with that id", gone.Message, StringComparison.Ordinal);
        Assert.Contains("it is limited to one interface", readOnly.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Turning_the_firewall_on_or_off_needs_a_step_up()
    {
        var on = FirewallChangePlanner.Plan(Ufw(active: false), [Add(Tcp(22)), Enable()]);
        var off = FirewallChangePlanner.Plan(Ufw(), [Disable()]);

        Assert.True(on.Result.Active);
        Assert.True(on.Enable);
        Assert.True(on.NeedsStepUp);
        Assert.False(off.Result.Active);
        Assert.True(off.NeedsStepUp);
    }

    [Fact]
    public void Ufw_with_ipv6_off_has_it_turned_on_and_the_plan_says_what_that_means()
    {
        var current = Ufw() with { Ipv6 = false };

        var plan = FirewallChangePlanner.Plan(current, [Add(Tcp(80))]);

        Assert.True(plan.Result.Ipv6);
        Assert.Contains(plan.Notes, note => note.Contains("IPv6", StringComparison.Ordinal));
    }

    [Fact]
    public void The_default_incoming_policy_changes()
    {
        var plan = FirewallChangePlanner.Plan(Ufw(), [Incoming(FirewallPolicy.Reject)]);

        Assert.Equal(FirewallPolicy.Reject, plan.Result.DefaultIncoming);
        Assert.Equal(FirewallPolicy.Reject, plan.DefaultIncoming);
        Assert.Equal("Set the default for incoming traffic to reject", plan.Summary);
    }

    [Fact]
    public void The_summary_reads_like_a_sentence()
    {
        var plan = FirewallChangePlanner.Plan(Ufw(active: false), [Add(Tcp(22)), Add(Tcp(443)), Enable()]);

        Assert.Equal("Allow 22/tcp from anywhere; allow 443/tcp from anywhere; turn the firewall on", plan.Summary);
    }

    [Theory]
    [InlineData(0, null, "A port is a number from 1 to 65535")]
    [InlineData(65536, null, "A port is a number from 1 to 65535")]
    [InlineData(8000, 7999, "from a lower port to a higher one")]
    [InlineData(8000, 70000, "A port is a number from 1 to 65535")]
    public void Ports_are_checked(int port, int? portTo, string reason)
    {
        var refusal = Refused(Ufw(), Add(new FirewallRuleSpec(FirewallAction.Allow, FirewallProtocol.Tcp, port, portTo)));

        Assert.Contains(reason, refusal.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void A_range_needs_a_protocol_and_a_rule_for_every_port_needs_a_source()
    {
        var range = Refused(Ufw(), Add(new FirewallRuleSpec(FirewallAction.Allow, FirewallProtocol.Any, 6000, 6007)));
        var everything = Refused(Ufw(), Add(new FirewallRuleSpec(FirewallAction.Allow, FirewallProtocol.Any)));
        var plan = FirewallChangePlanner.Plan(Ufw(), [Add(new FirewallRuleSpec(FirewallAction.Allow, FirewallProtocol.Any, Source: "192.168.1.10"))]);

        Assert.Contains("needs TCP or UDP", range.Message, StringComparison.Ordinal);
        Assert.Contains("needs a source", everything.Message, StringComparison.Ordinal);
        Assert.Equal("Allow everything from 192.168.1.10", FirewallEvaluation.Describe(Assert.Single(plan.Added)));
    }

    [Fact]
    public void A_range_of_one_port_is_a_single_port()
    {
        var plan = FirewallChangePlanner.Plan(Ufw(), [Add(new FirewallRuleSpec(FirewallAction.Allow, FirewallProtocol.Tcp, 8080, 8080))]);

        Assert.Equal(new PortRange(8080, 8080), Assert.Single(plan.Added).Ports);
    }

    [Theory]
    [InlineData("line\nbreak")]
    [InlineData("tab\there")]
    [InlineData("a comment that is far too long to be useful in a firewall listing anyway, really")]
    public void Comments_are_short_and_on_one_line(string comment)
    {
        var refusal = Refused(Ufw(), Add(Tcp(80, comment: comment)));

        Assert.Contains("Comments have at most 64 characters", refusal.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void A_comment_keeps_its_text_on_ufw_and_firewalld_says_it_keeps_none()
    {
        var ufw = FirewallChangePlanner.Plan(Ufw(), [Add(Tcp(80, comment: "web ünicode"))]);
        var firewalld = FirewallChangePlanner.Plan(Firewalld(), [Add(Tcp(80, comment: "web"))]);

        Assert.Equal("web ünicode", Assert.Single(ufw.Added).Comment);
        Assert.Contains(firewalld.Notes, note => note.Contains("firewalld keeps no comments", StringComparison.Ordinal));
    }

    [Fact]
    public void Limit_is_ufw_only()
    {
        var refusal = Refused(Firewalld(), Add(Tcp(22, action: FirewallAction.Limit)));

        Assert.Contains("only ufw", refusal.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void A_bad_source_is_refused_with_the_address_reasons()
    {
        var refusal = Refused(Ufw(), Add(Tcp(22, "10.0.0.5/8")));

        Assert.Contains("did you mean 10.0.0.0/8", refusal.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Change_sets_are_refused_when_they_make_no_sense()
    {
        Assert.Contains("1 to 50 changes", Refused(Ufw()).Message, StringComparison.Ordinal);
        Assert.Contains("on or off, not both", Refused(Ufw(), Enable(), Disable()).Message, StringComparison.Ordinal);
        Assert.Contains("once", Refused(Ufw(), Incoming(FirewallPolicy.Deny), Incoming(FirewallPolicy.Allow)).Message, StringComparison.Ordinal);
        Assert.Contains("needs a rule", Refused(Ufw(), new FirewallChange(FirewallChangeKind.AddRule)).Message, StringComparison.Ordinal);
        Assert.Contains("needs a policy", Refused(Ufw(), new FirewallChange(FirewallChangeKind.SetDefaultIncoming)).Message, StringComparison.Ordinal);
        Assert.Contains("not a change", Refused(Ufw(), new FirewallChange((FirewallChangeKind)42)).Message, StringComparison.Ordinal);
        Assert.Contains(
            "not an action",
            Refused(Ufw(), Add(new FirewallRuleSpec((FirewallAction)42, FirewallProtocol.Tcp, 22))).Message,
            StringComparison.Ordinal);
    }

    [Fact]
    public void A_firewall_that_cannot_take_a_change_now_says_why()
    {
        var unsaved = Firewalld() with { RefusalReason = "firewalld is running rules that are not saved" };

        var refusal = Refused(unsaved, Add(Tcp(80)));

        Assert.Equal("firewalld is running rules that are not saved", refusal.Message);
    }

    [Fact]
    public void Without_a_firewall_there_is_nothing_to_change()
    {
        var refusal = Refused(new FirewallState { Backend = FirewallBackendKind.None, Installed = false }, Add(Tcp(22)));

        Assert.Contains("Neither ufw nor firewalld is installed", refusal.Message, StringComparison.Ordinal);
    }
}
