using System.Net;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Firewall;
using static Runova.ServerCore.Tests.FirewallTestData;

namespace Runova.ServerCore.Tests;

/// <summary>
/// AC2: a change set that would stop this computer from opening a new SSH connection is refused
/// unless a person types the phrase the guard gives. The guard judges the firewall the change
/// would leave, the way each backend evaluates it, and assumes the worst where it cannot tell.
/// </summary>
public sealed class LockoutGuardTests
{
    [Fact]
    public void A_firewall_that_is_off_blocks_nothing()
    {
        var verdict = LockoutGuard.Check(Ufw(active: false), Access());

        Assert.False(verdict.Blocked);
        Assert.Null(verdict.ConfirmationPhrase);
    }

    [Fact]
    public void Deny_by_default_with_ssh_allowed_keeps_ssh_open()
    {
        var verdict = LockoutGuard.Check(Ufw(rules: [Allow(22)]), Access());

        Assert.False(verdict.Blocked);
        Assert.Equal(["SSH from 203.0.113.50 to port 22: allowed by \"Allow 22/tcp from anywhere\""], verdict.Checked);
    }

    [Fact]
    public void Deny_by_default_without_an_ssh_rule_is_blocked_and_says_how_to_go_ahead()
    {
        var verdict = LockoutGuard.Check(Ufw(rules: [Allow(80)]), Access());

        Assert.True(verdict.Blocked);
        Assert.Equal("block ssh on port 22", verdict.ConfirmationPhrase);
        var reason = Assert.Single(verdict.Reasons);
        Assert.Contains("New SSH connections from 203.0.113.50 to port 22 would be dropped", reason, StringComparison.Ordinal);
        Assert.Contains("default for incoming traffic is deny and no rule allows it", reason, StringComparison.Ordinal);
    }

    [Fact]
    public void A_deny_rule_on_this_computers_address_is_blocked_and_named()
    {
        var verdict = LockoutGuard.Check(Ufw(rules: [Deny("203.0.113.0/24"), Allow(22)]), Access());

        Assert.True(verdict.Blocked);
        Assert.Contains("\"Deny everything from 203.0.113.0/24\"", Assert.Single(verdict.Reasons), StringComparison.Ordinal);
    }

    [Fact]
    public void Ssh_open_only_to_another_network_is_blocked_and_open_to_this_one_is_fine()
    {
        var elsewhere = LockoutGuard.Check(Ufw(rules: [Allow(22, "198.51.100.0/24")]), Access());
        var here = LockoutGuard.Check(Ufw(rules: [Allow(22, "203.0.113.0/24")]), Access());

        Assert.True(elsewhere.Blocked);
        Assert.False(here.Blocked);
    }

    [Fact]
    public void Ufw_lets_the_first_matching_rule_decide_and_firewalld_lets_a_deny_win()
    {
        var ufw = LockoutGuard.Check(Ufw(rules: [Allow(22), Deny("203.0.113.0/24")]), Access());
        var firewalld = LockoutGuard.Check(
            Firewalld(rules: [Allow(22, shape: "port"), Deny("203.0.113.0/24", shape: "rich")]),
            Access());

        Assert.False(ufw.Blocked);
        Assert.True(firewalld.Blocked);
    }

    [Fact]
    public void Firewalld_runs_a_negative_priority_rule_before_its_denies()
    {
        var early = Allow(22, "203.0.113.0/24", "rich") with { Priority = -5 };

        var verdict = LockoutGuard.Check(Firewalld(rules: [Deny("203.0.113.0/24", "rich"), early]), Access());

        Assert.False(verdict.Blocked);
    }

    [Fact]
    public void A_zone_that_accepts_everything_keeps_ssh_open()
    {
        Assert.False(LockoutGuard.Check(Firewalld(target: FirewallPolicy.Allow), Access()).Blocked);
        Assert.True(LockoutGuard.Check(Firewalld(target: FirewallPolicy.Reject), Access()).Blocked);
    }

    [Fact]
    public void A_v4_only_rule_does_not_keep_ssh_open_for_an_ipv6_address()
    {
        var v4Only = Allow(22) with { Families = FirewallFamilies.Ipv4 };

        var verdict = LockoutGuard.Check(Ufw(rules: [v4Only]), new SshAccess([AppV6], [22], [22]));

        Assert.True(verdict.Blocked);
    }

    [Fact]
    public void Ufw_without_ipv6_filtering_leaves_an_ipv6_address_alone()
    {
        var verdict = LockoutGuard.Check(Ufw() with { Ipv6 = false }, new SshAccess([AppV6], [22], [22]));

        Assert.False(verdict.Blocked);
    }

    [Fact]
    public void Every_address_this_computer_is_known_by_must_stay_open()
    {
        var verdict = LockoutGuard.Check(
            Ufw(rules: [Allow(22, "203.0.113.0/24")]),
            new SshAccess([App, IPAddress.Parse("198.51.100.20")], [22], [22]));

        Assert.True(verdict.Blocked);
        Assert.Contains("198.51.100.20", Assert.Single(verdict.Reasons), StringComparison.Ordinal);
        Assert.Equal(2, verdict.Checked.Length);
    }

    [Fact]
    public void The_port_this_connection_uses_is_checked_and_every_sshd_port_when_it_is_unknown()
    {
        var only2222 = Ufw(rules: [Allow(2222)]);

        var knownPort = LockoutGuard.Check(only2222, new SshAccess([App], [2222], [22, 2222]));
        var unknownPort = LockoutGuard.Check(only2222, new SshAccess([App], [], [22, 2222]));

        Assert.False(knownPort.Blocked);
        Assert.True(unknownPort.Blocked);
        Assert.Contains("port 22 ", Assert.Single(unknownPort.Reasons), StringComparison.Ordinal);
    }

    [Fact]
    public void Not_knowing_this_computers_address_is_refused_too()
    {
        var verdict = LockoutGuard.Check(Ufw(rules: [Allow(22)]), new SshAccess([], [22], [22]));

        Assert.True(verdict.Blocked);
        Assert.Equal(LockoutGuard.UnknownPhrase, verdict.ConfirmationPhrase);
        Assert.Contains("cannot tell which address", Assert.Single(verdict.Reasons), StringComparison.Ordinal);
    }

    [Fact]
    public void An_allow_the_core_cannot_be_sure_of_does_not_count_and_such_a_deny_does()
    {
        var onInterface = Allow(22) with { Interface = "eth0" };
        var rateLimitedDeny = Rule(FirewallAction.Deny, 22) with { Unknown = "a rate limit" };

        var allow = LockoutGuard.Check(Ufw(rules: [onInterface]), Access());
        var deny = LockoutGuard.Check(Ufw(rules: [rateLimitedDeny, Allow(22)]), Access());

        Assert.True(allow.Blocked);
        Assert.True(deny.Blocked);
        Assert.Contains("might", Assert.Single(deny.Reasons), StringComparison.Ordinal);
    }

    [Fact]
    public void A_deny_for_another_port_never_counts_even_when_the_core_cannot_read_all_of_it()
    {
        var otherPort = Rule(FirewallAction.Deny, 9000) with { Unknown = "a rate limit" };

        Assert.False(LockoutGuard.Check(Ufw(rules: [otherPort, Allow(22)]), Access()).Blocked);
    }

    [Fact]
    public void A_rule_for_the_servers_own_address_counts_when_that_address_is_known()
    {
        var toServer = Allow(22) with { Destination = Network("192.0.2.10") };

        var known = LockoutGuard.Check(Ufw(rules: [toServer]), new SshAccess([App], [22], [22], IPAddress.Parse("192.0.2.10")));
        var other = LockoutGuard.Check(Ufw(rules: [toServer]), new SshAccess([App], [22], [22], IPAddress.Parse("192.0.2.11")));

        Assert.False(known.Blocked);
        Assert.True(other.Blocked);
    }

    [Fact]
    public void A_negated_source_matches_everyone_else()
    {
        var notApp = Rule(FirewallAction.Deny, protocol: FirewallProtocol.Any, source: "203.0.113.0/24", shape: "rich") with { SourceNegated = true };

        Assert.False(LockoutGuard.Check(Firewalld(rules: [notApp, Allow(22, shape: "port")]), Access()).Blocked);
        Assert.True(LockoutGuard.Check(
            Firewalld(rules: [notApp, Allow(22, shape: "port")]),
            new SshAccess([IPAddress.Parse("198.51.100.1")], [22], [22])).Blocked);
    }

    [Fact]
    public void Ufws_limit_keeps_ssh_open()
    {
        var verdict = LockoutGuard.Check(Ufw(rules: [Rule(FirewallAction.Limit, 22)]), Access());

        Assert.False(verdict.Blocked);
        Assert.Contains("Limit 22/tcp from anywhere", Assert.Single(verdict.Checked), StringComparison.Ordinal);
    }

    [Fact]
    public void Loopback_always_gets_in()
    {
        Assert.False(LockoutGuard.Check(Ufw(), new SshAccess([IPAddress.Loopback], [22], [22])).Blocked);
    }

    [Fact]
    public void Outgoing_rules_never_decide_a_connection_in()
    {
        var outgoing = Rule(FirewallAction.Allow, 22) with { Outgoing = true };

        Assert.True(LockoutGuard.Check(Ufw(rules: [outgoing]), Access()).Blocked);
    }

    [Theory]
    [InlineData("block ssh on port 22", true)]
    [InlineData("  Block SSH on  port 22 ", true)]
    [InlineData("block ssh on port 2222", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void The_typed_phrase_must_be_the_one_asked_for(string? typed, bool confirms)
    {
        var verdict = LockoutGuard.Check(Ufw(), Access());

        Assert.Equal(confirms, LockoutGuard.Confirms(verdict, typed));
    }

    [Fact]
    public void A_verdict_that_blocks_nothing_needs_no_phrase()
    {
        var verdict = LockoutGuard.Check(Ufw(active: false), Access());

        Assert.True(LockoutGuard.Confirms(verdict, null));
    }
}
