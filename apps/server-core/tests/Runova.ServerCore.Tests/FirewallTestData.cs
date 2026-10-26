using System.Net;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Firewall;

namespace Runova.ServerCore.Tests;

/// <summary>Firewall states and rules for tests, built the way the backends read them.</summary>
internal static class FirewallTestData
{
    public static readonly IPAddress App = IPAddress.Parse("203.0.113.50");

    public static readonly IPAddress AppV6 = IPAddress.Parse("2001:db8:50::7");

    public static SshAccess Access(params int[] ports) => new([App], ports.Length == 0 ? [22] : ports, [22]);

    public static FirewallState Ufw(bool active = true, FirewallPolicy incoming = FirewallPolicy.Deny, params FirewallRule[] rules) =>
        new()
        {
            Backend = FirewallBackendKind.Ufw,
            Active = active,
            DefaultIncoming = incoming,
            Rules = Ordered(rules),
        };

    public static FirewallState Firewalld(bool active = true, FirewallPolicy target = FirewallPolicy.Reject, params FirewallRule[] rules) =>
        new()
        {
            Backend = FirewallBackendKind.Firewalld,
            Active = active,
            DefaultIncoming = target,
            Zone = "public",
            Rules = rules,
        };

    /// <summary>Gives ufw rules their place in each family's list, as they come.</summary>
    public static IReadOnlyList<FirewallRule> Ordered(IEnumerable<FirewallRule> rules) =>
        [.. rules.Select((rule, index) => rule with { Ipv4Order = index, Ipv6Order = index })];

    public static FirewallRule Rule(
        FirewallAction action,
        int? port = null,
        FirewallProtocol protocol = FirewallProtocol.Tcp,
        string? source = null,
        string shape = "ufw",
        int? portTo = null)
    {
        IPNetwork? network = source is null ? null : Network(source);
        return new FirewallRule
        {
            Action = action,
            Shape = shape,
            Protocol = protocol,
            Ports = port is int from ? new PortRange(from, portTo ?? from) : null,
            Source = network,
            Families = network is { } n
                ? n.BaseAddress.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6 ? FirewallFamilies.Ipv6 : FirewallFamilies.Ipv4
                : FirewallFamilies.Both,
        };
    }

    public static FirewallRule Allow(int port, string? source = null, string shape = "ufw") =>
        Rule(FirewallAction.Allow, port, source: source, shape: shape);

    public static FirewallRule Deny(string source, string shape = "ufw") =>
        Rule(FirewallAction.Deny, protocol: FirewallProtocol.Any, source: source, shape: shape);

    public static IPNetwork Network(string text)
    {
        Assert.True(FirewallAddresses.TryParseNetwork(text, out var network, out var error), error);
        return network;
    }

    public static FirewallChange Add(FirewallRuleSpec rule) => new(FirewallChangeKind.AddRule, Rule: rule);

    public static FirewallChange Remove(string id) => new(FirewallChangeKind.RemoveRule, RuleId: id);

    public static FirewallChange Enable() => new(FirewallChangeKind.Enable);

    public static FirewallChange Disable() => new(FirewallChangeKind.Disable);

    public static FirewallChange Incoming(FirewallPolicy policy) => new(FirewallChangeKind.SetDefaultIncoming, Policy: policy);

    public static FirewallRuleSpec Tcp(int port, string? source = null, FirewallAction action = FirewallAction.Allow, string? comment = null) =>
        new(action, FirewallProtocol.Tcp, port, Source: source, Comment: comment);
}
