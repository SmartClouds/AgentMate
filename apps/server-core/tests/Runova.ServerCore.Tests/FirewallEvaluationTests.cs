using System.Net;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Firewall;
using static Runova.ServerCore.Tests.FirewallTestData;

namespace Runova.ServerCore.Tests;

/// <summary>How a single rule matches a connection, and how rules read to a person.</summary>
public sealed class FirewallEvaluationTests
{
    private static Probe Ssh(string source = "203.0.113.50", int port = 22) => new(IPAddress.Parse(source), port, FirewallProtocol.Tcp);

    [Fact]
    public void A_rule_matches_on_protocol_port_and_source()
    {
        Assert.Equal(RuleMatch.Yes, FirewallEvaluation.Match(Allow(22), Ssh()));
        Assert.Equal(RuleMatch.No, FirewallEvaluation.Match(Allow(80), Ssh()));
        Assert.Equal(RuleMatch.No, FirewallEvaluation.Match(Rule(FirewallAction.Allow, 22, FirewallProtocol.Udp), Ssh()));
        Assert.Equal(RuleMatch.Yes, FirewallEvaluation.Match(Rule(FirewallAction.Allow, 22, FirewallProtocol.Any), Ssh()));
        Assert.Equal(RuleMatch.Yes, FirewallEvaluation.Match(Rule(FirewallAction.Allow, 20, portTo: 30), Ssh()));
        Assert.Equal(RuleMatch.No, FirewallEvaluation.Match(Allow(22, "10.0.0.0/8"), Ssh()));
        Assert.Equal(RuleMatch.No, FirewallEvaluation.Match(Allow(22, "2001:db8::/32"), Ssh()));
    }

    [Fact]
    public void A_rule_with_something_the_core_cannot_read_might_match()
    {
        Assert.Equal(RuleMatch.Maybe, FirewallEvaluation.Match(Allow(22) with { Unknown = "a source port" }, Ssh()));
        Assert.Equal(RuleMatch.Maybe, FirewallEvaluation.Match(Allow(22) with { Interface = "eth0" }, Ssh()));
        Assert.Equal(RuleMatch.Maybe, FirewallEvaluation.Match(Allow(22) with { Destination = Network("192.0.2.10") }, Ssh()));
    }

    [Theory]
    [InlineData(FirewallAction.Allow, 22, null, null, "Allow 22/tcp from anywhere")]
    [InlineData(FirewallAction.Deny, 23, null, null, "Deny 23/tcp from anywhere")]
    [InlineData(FirewallAction.Reject, 6000, 6007, null, "Reject 6000-6007/tcp from anywhere")]
    [InlineData(FirewallAction.Limit, 2222, null, null, "Limit 2222/tcp from anywhere")]
    [InlineData(FirewallAction.Allow, 5432, null, "10.0.0.0/8", "Allow 5432/tcp from 10.0.0.0/8")]
    public void Rules_read_like_a_sentence(FirewallAction action, int port, int? portTo, string? source, string description) =>
        Assert.Equal(description, FirewallEvaluation.Describe(Rule(action, port, source: source, portTo: portTo)));

    [Fact]
    public void Every_kind_of_rule_has_a_description()
    {
        Assert.Equal("Allow 53 (TCP and UDP) from anywhere", FirewallEvaluation.Describe(Rule(FirewallAction.Allow, 53, FirewallProtocol.Any)));
        Assert.Equal("Allow everything from 192.168.1.10", FirewallEvaluation.Describe(Rule(FirewallAction.Allow, protocol: FirewallProtocol.Any, source: "192.168.1.10")));
        Assert.Equal("Allow 8443/tcp on eth0 from anywhere", FirewallEvaluation.Describe(Allow(8443) with { Interface = "eth0" }));
        Assert.Equal("Allow 9000/tcp to 172.17.0.2 from 198.51.100.0/24", FirewallEvaluation.Describe(Allow(9000, "198.51.100.0/24") with { Destination = Network("172.17.0.2") }));
        Assert.Equal("Allow ssh (22/tcp) from anywhere", FirewallEvaluation.Describe(Allow(22, shape: "service") with { Service = "ssh" }));
        Assert.Equal("Deny outgoing 25 (TCP and UDP) to anywhere", FirewallEvaluation.Describe(Rule(FirewallAction.Deny, 25, FirewallProtocol.Any) with { Outgoing = true }));
        Assert.Equal("Deny 9000/tcp from everywhere but 192.0.2.0/24", FirewallEvaluation.Describe(Rule(FirewallAction.Deny, 9000, source: "192.0.2.0/24") with { SourceNegated = true }));
    }

    [Fact]
    public void A_rules_id_ignores_its_place_and_comment_but_not_what_it_does()
    {
        var rule = Allow(22);

        Assert.Equal(rule.Id, (rule with { Ipv4Order = 7, Comment = "ssh" }).Id);
        Assert.NotEqual(rule.Id, Allow(2222).Id);
        Assert.NotEqual(rule.Id, (rule with { Families = FirewallFamilies.Ipv4 }).Id);
        Assert.Matches("^[0-9a-f]{16}$", rule.Id);
    }

    [Fact]
    public void The_app_gets_rules_as_plain_records()
    {
        var info = FirewallEvaluation.ToInfo(Allow(5432, "10.0.0.0/8") with { Comment = "db", ReadOnlyReason = "made by hand" });

        Assert.Equal(FirewallAction.Allow, info.Action);
        Assert.Equal(5432, info.Port);
        Assert.Null(info.PortTo);
        Assert.Equal("10.0.0.0/8", info.Source);
        Assert.Equal("db", info.Comment);
        Assert.Equal(FirewallFamilies.Ipv4, info.Families);
        Assert.False(info.Editable);
        Assert.Equal("made by hand", info.Note);
    }
}
