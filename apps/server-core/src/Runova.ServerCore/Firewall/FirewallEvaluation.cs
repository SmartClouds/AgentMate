using System.Net;
using System.Net.Sockets;
using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.Firewall;

/// <summary>
/// Decides whether a new connection would get through a firewall state, the way the backend
/// would: ufw checks each family's rules in order and the first match wins; firewalld runs rich
/// rules with a negative priority first, then every deny and reject, then every allow, then the
/// positive priorities, and the zone's target last. A rule that might match (see RuleMatch.Maybe)
/// counts when it would block, never when it would allow.
/// </summary>
internal static class FirewallEvaluation
{
    public static RuleMatch Match(FirewallRule rule, Probe probe)
    {
        ArgumentNullException.ThrowIfNull(rule);
        var source = FirewallAddresses.Normalize(probe.Source);
        var v6 = source.AddressFamily == AddressFamily.InterNetworkV6;
        if (rule.Outgoing || rule.Routed || (v6 ? !rule.CoversIpv6 : !rule.CoversIpv4))
        {
            return RuleMatch.No;
        }

        if ((rule.Protocol != FirewallProtocol.Any && rule.Protocol != probe.Protocol)
            || (rule.Ports is { } ports && !ports.Contains(probe.Port))
            || (rule.PortList is { Count: > 0 } list && !list.Any(range => range.Contains(probe.Port))))
        {
            return RuleMatch.No;
        }

        if (rule.Source is { } network && network.Contains(source) == rule.SourceNegated)
        {
            return RuleMatch.No;
        }

        var unsure = rule.Interface is not null || rule.Unknown is not null;
        if (rule.Destination is { } destination)
        {
            if (probe.Destination is not { } server)
            {
                unsure = true;
            }
            else if (!destination.Contains(FirewallAddresses.Normalize(server)))
            {
                return RuleMatch.No;
            }
        }

        return unsure ? RuleMatch.Maybe : RuleMatch.Yes;
    }

    public static FirewallVerdict Evaluate(FirewallState state, Probe probe)
    {
        ArgumentNullException.ThrowIfNull(state);
        var source = FirewallAddresses.Normalize(probe.Source);
        if (IPAddress.IsLoopback(source))
        {
            return new FirewallVerdict(true, "allowed: traffic over loopback always gets in");
        }

        if (!state.Active)
        {
            return new FirewallVerdict(true, "allowed: the firewall is off");
        }

        var v6 = source.AddressFamily == AddressFamily.InterNetworkV6;
        if (v6 && !state.Ipv6)
        {
            return new FirewallVerdict(true, "allowed: ufw does not filter IPv6 (IPV6=no in /etc/default/ufw)");
        }

        var ordered = state.Backend == FirewallBackendKind.Firewalld ? FirewalldOrder(state.Rules) : UfwOrder(state.Rules, v6);
        foreach (var rule in ordered)
        {
            var match = Match(rule, probe with { Source = source });
            if (match == RuleMatch.No)
            {
                continue;
            }

            var blocks = Blocks(rule);
            if (match == RuleMatch.Maybe)
            {
                if (blocks)
                {
                    return new FirewallVerdict(
                        false,
                        $"the rule \"{Describe(rule)}\" might block them, and the core cannot tell for sure: {Unsure(rule)}",
                        rule,
                        "blocked");
                }

                continue;
            }

            if (blocks)
            {
                return new FirewallVerdict(
                    false,
                    $"the rule \"{Describe(rule)}\" blocks them",
                    rule,
                    rule.Action == FirewallAction.Reject ? "refused" : "dropped");
            }

            var limited = rule.Action == FirewallAction.Limit
                ? " (ufw refuses an address that opens six new connections within 30 seconds)"
                : string.Empty;
            return new FirewallVerdict(true, $"allowed by \"{Describe(rule)}\"{limited}", rule);
        }

        return state.DefaultIncoming == FirewallPolicy.Allow
            ? new FirewallVerdict(true, "allowed: the default for incoming traffic is allow")
            : new FirewallVerdict(
                false,
                $"the default for incoming traffic is {Word(state.DefaultIncoming)} and no rule allows it",
                Verb: state.DefaultIncoming == FirewallPolicy.Reject ? "refused" : "dropped");
    }

    /// <summary>How a person reads the rule: "Allow 22/tcp from anywhere".</summary>
    public static string Describe(FirewallRule rule)
    {
        ArgumentNullException.ThrowIfNull(rule);
        var parts = new List<string> { rule.Action.ToString() };
        if (rule.Outgoing)
        {
            parts.Add("outgoing");
        }
        else if (rule.Routed)
        {
            parts.Add("routed");
        }

        parts.Add(What(rule));
        if (rule.Interface is { } name)
        {
            parts.Add($"on {name}");
        }

        if (rule.Outgoing)
        {
            parts.Add(rule.Destination is { } to ? $"to {FirewallAddresses.Format(to)}" : "to anywhere");
        }
        else
        {
            if (rule.Destination is { } to)
            {
                parts.Add($"to {FirewallAddresses.Format(to)}");
            }

            parts.Add(rule.Source switch
            {
                null => "from anywhere",
                { } from when rule.SourceNegated => $"from everywhere but {FirewallAddresses.Format(from)}",
                { } from => $"from {FirewallAddresses.Format(from)}",
            });
        }

        var text = string.Join(' ', parts);
        return rule.Source is null && rule.Families != FirewallFamilies.Both
            ? $"{text} ({(rule.Families == FirewallFamilies.Ipv4 ? "IPv4" : "IPv6")} only)"
            : text;
    }

    public static FirewallRuleInfo ToInfo(FirewallRule rule)
    {
        ArgumentNullException.ThrowIfNull(rule);
        return new FirewallRuleInfo(
            rule.Id,
            rule.Action,
            rule.Protocol,
            rule.Families,
            Describe(rule),
            rule.Editable,
            rule.Ports?.From,
            rule.Ports is { IsSingle: false } range ? range.To : null,
            rule.Source is { } source && !rule.SourceNegated ? FirewallAddresses.Format(source) : null,
            rule.Comment,
            rule.Service,
            rule.Interface,
            rule.Destination is { } destination ? FirewallAddresses.Format(destination) : null,
            rule.Outgoing,
            rule.ReadOnlyReason ?? rule.Unknown);
    }

    public static bool Blocks(FirewallRule rule) => rule.Action is FirewallAction.Deny or FirewallAction.Reject;

    public static string Word(FirewallPolicy policy) => policy switch
    {
        FirewallPolicy.Allow => "allow",
        FirewallPolicy.Deny => "deny",
        _ => "reject",
    };

    /// <summary>ufw: the family's own list, in order.</summary>
    private static IEnumerable<FirewallRule> UfwOrder(IReadOnlyList<FirewallRule> rules, bool v6) =>
        v6
            ? rules.Where(rule => rule.CoversIpv6).OrderBy(rule => rule.Ipv6Order)
            : rules.Where(rule => rule.CoversIpv4).OrderBy(rule => rule.Ipv4Order);

    /// <summary>firewalld's chains: negative priorities, denies, allows, positive priorities.</summary>
    private static IEnumerable<FirewallRule> FirewalldOrder(IReadOnlyList<FirewallRule> rules) =>
        rules
            .OrderBy(rule => rule.Priority < 0 ? 0 : rule.Priority == 0 ? 1 : 2)
            .ThenBy(rule => rule.Priority)
            .ThenBy(rule => Blocks(rule) ? 0 : 1);

    private static string What(FirewallRule rule)
    {
        var ports = rule.PortsText;
        var withProtocol = ports is null
            ? null
            : rule.Protocol == FirewallProtocol.Any
                ? $"{ports} (TCP and UDP)"
                : $"{ports}/{rule.Protocol.ToString().ToLowerInvariant()}";
        if (rule.Service is { } service)
        {
            return withProtocol is null ? service : $"{service} ({withProtocol})";
        }

        return withProtocol ?? "everything";
    }

    private static string Unsure(FirewallRule rule) =>
        rule.Unknown
        ?? (rule.Interface is { } name
            ? $"it applies to traffic on {name} only"
            : rule.Destination is { } to ? $"it applies to traffic for {FirewallAddresses.Format(to)} only" : "part of it cannot be read");
}
