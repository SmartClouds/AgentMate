using System.Globalization;
using System.Net;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Firewall;

namespace Runova.ServerCore.Cloudflare;

/// <summary>The firewall changes for the lock, and what the person should know about them.</summary>
internal sealed record OriginLockPlan(IReadOnlyList<FirewallChange> Changes, IReadOnlyList<string> Notes);

/// <summary>How the firewall differs from what the lock needs (all empty: it matches).</summary>
internal sealed record OriginLockComparison(IReadOnlyList<string> Missing, IReadOnlyList<string> Open, IReadOnlyList<string> Stale)
{
    public bool Matches => Missing.Count == 0 && Open.Count == 0 && Stale.Count == 0;
}

/// <summary>
/// Works out the firewall rules of the origin lock from the firewall as it is: an allow rule for
/// each Cloudflare range on 80/tcp and 443/tcp, and none that lets everyone else reach those
/// ports. Rules that already match are kept, so planning again after a change finds nothing to do.
/// Ranges Cloudflare no longer lists are recognised by the lock's comment (ufw) or by being among
/// the ranges the lock was last built from (firewalld keeps no comments).
/// </summary>
internal static class OriginLockPlanner
{
    public const string Comment = "cloudflare origin lock";

    public static IReadOnlyList<int> Ports { get; } = [80, 443];

    /// <summary>Documentation addresses (RFC 5737, RFC 3849): never Cloudflare, so a rule letting them in lets everyone in.</summary>
    private static readonly IPAddress[] _outsiders = [IPAddress.Parse("192.0.2.1"), IPAddress.Parse("2001:db8::1")];

    public static OriginLockComparison Compare(FirewallState state, CloudflareRanges ranges, IReadOnlyCollection<string>? previous = null)
    {
        ArgumentNullException.ThrowIfNull(state);
        ArgumentNullException.ThrowIfNull(ranges);
        var wanted = Networks(ranges);
        var missing = new List<string>();
        foreach (var network in wanted)
        {
            foreach (var port in Ports)
            {
                if (!state.Rules.Any(rule => AllowsFrom(rule, port, network)))
                {
                    missing.Add($"Allow {Number(port)}/tcp from {FirewallAddresses.Format(network)}");
                }
            }
        }

        var open = OpenRules(state).Select(FirewallEvaluation.Describe).Distinct(StringComparer.Ordinal).ToList();
        if (state.Active && state.DefaultIncoming == FirewallPolicy.Allow)
        {
            open.Insert(0, "The default for incoming traffic is allow");
        }

        if (!state.Active)
        {
            open.Insert(0, "The firewall is off");
        }

        var stale = StaleRules(state, wanted, previous).Select(FirewallEvaluation.Describe).Distinct(StringComparer.Ordinal).ToList();
        return new OriginLockComparison(missing, open, stale);
    }

    /// <summary>The changes that turn the lock on (or bring it up to date), or off.</summary>
    public static OriginLockPlan Plan(FirewallState state, CloudflareRanges ranges, bool enable, IReadOnlyCollection<string>? previous = null)
    {
        ArgumentNullException.ThrowIfNull(state);
        ArgumentNullException.ThrowIfNull(ranges);
        var wanted = Networks(ranges);
        var changes = new List<FirewallChange>();
        var notes = new List<string>();
        if (enable)
        {
            if (!state.Active)
            {
                throw new FirewallRefusedException("The firewall is off, so it cannot keep anyone out. Turn it on in the Firewall section first, then lock the origin.");
            }

            if (state.DefaultIncoming == FirewallPolicy.Allow)
            {
                throw new FirewallRefusedException("The firewall lets every connection in by default, so limiting ports 80 and 443 would change nothing. Set the default for incoming traffic to deny first.");
            }

            foreach (var network in wanted)
            {
                foreach (var port in Ports)
                {
                    if (!state.Rules.Any(rule => AllowsFrom(rule, port, network)))
                    {
                        changes.Add(new FirewallChange(
                            FirewallChangeKind.AddRule,
                            new FirewallRuleSpec(FirewallAction.Allow, FirewallProtocol.Tcp, port, Source: FirewallAddresses.Format(network), Comment: Comment)));
                    }
                }
            }

            foreach (var rule in OpenRules(state).Concat(StaleRules(state, wanted, previous)).DistinctBy(rule => rule.Id))
            {
                if (rule.Editable && IsSinglePortRule(rule))
                {
                    changes.Add(new FirewallChange(FirewallChangeKind.RemoveRule, RuleId: rule.Id));
                }
                else
                {
                    notes.Add($"\"{FirewallEvaluation.Describe(rule)}\" still lets other addresses reach the site"
                        + (rule.ReadOnlyReason is { } why ? $" and the core cannot change it ({why})" : " and covers other ports too")
                        + ". Remove or narrow it in the Firewall section, or the lock does not hold.");
                }
            }

            if (state.Backend == FirewallBackendKind.Ufw && !state.Ipv6)
            {
                notes.Add("ufw is not set up for IPv6 (IPV6=no), so the IPv6 ranges cannot be added. Set IPV6=yes in /etc/default/ufw.");
            }
        }
        else
        {
            foreach (var rule in state.Rules.Where(rule => IsLockRule(rule, wanted, previous) && rule.Editable).DistinctBy(rule => rule.Id))
            {
                changes.Add(new FirewallChange(FirewallChangeKind.RemoveRule, RuleId: rule.Id));
            }

            foreach (var port in Ports)
            {
                if (!OpenRules(state).Any(rule => Covers(rule, port)))
                {
                    changes.Add(new FirewallChange(FirewallChangeKind.AddRule, new FirewallRuleSpec(FirewallAction.Allow, FirewallProtocol.Tcp, port)));
                }
            }
        }

        if (changes.Count > FirewallChangePlanner.MaxChanges)
        {
            throw new FirewallRefusedException(
                $"Cloudflare lists {Number(wanted.Count)} ranges, which needs {Number(changes.Count)} firewall changes; one change set takes at most {Number(FirewallChangePlanner.MaxChanges)}.");
        }

        return new OriginLockPlan(changes, notes);
    }

    private static List<IPNetwork> Networks(CloudflareRanges ranges) =>
        [.. CloudflareRangeList.All(ranges).Select(IPNetwork.Parse)];

    /// <summary>An allow rule exactly for this port from exactly this network.</summary>
    private static bool AllowsFrom(FirewallRule rule, int port, IPNetwork network) =>
        rule is { Action: FirewallAction.Allow, Outgoing: false, Routed: false, SourceNegated: false, Interface: null, Destination: null, Unknown: null, PortList: null }
        && rule.Protocol is FirewallProtocol.Tcp or FirewallProtocol.Any
        && rule.Ports is { IsSingle: true } ports && ports.From == port
        && rule.Source is { } source && source.Equals(network);

    /// <summary>Rules that let an address that is not Cloudflare reach 80 or 443.</summary>
    private static IEnumerable<FirewallRule> OpenRules(FirewallState state) =>
        state.Rules.Where(rule => rule.Action is FirewallAction.Allow or FirewallAction.Limit && Ports.Any(port => Covers(rule, port)));

    private static bool Covers(FirewallRule rule, int port) =>
        rule.Action is FirewallAction.Allow or FirewallAction.Limit
        && _outsiders.Any(outsider => FirewallEvaluation.Match(rule, new Probe(outsider, port, FirewallProtocol.Tcp)) != RuleMatch.No);

    private static bool IsSinglePortRule(FirewallRule rule) =>
        rule.PortList is null
        && ((rule.Ports is { IsSingle: true } ports && Ports.Contains(ports.From))
            || (rule.Ports is null && rule.Service is "http" or "https"));

    /// <summary>A lock rule for a range Cloudflare no longer lists.</summary>
    private static IEnumerable<FirewallRule> StaleRules(FirewallState state, List<IPNetwork> wanted, IReadOnlyCollection<string>? previous) =>
        state.Rules.Where(rule => IsLockRule(rule, wanted: [], previous) && rule.Source is { } source && !wanted.Contains(source));

    /// <summary>A rule the lock made: allowing 80 or 443 from a Cloudflare range, current or earlier.</summary>
    private static bool IsLockRule(FirewallRule rule, IEnumerable<IPNetwork> wanted, IReadOnlyCollection<string>? previous) =>
        rule.Source is { } source
        && Ports.Any(port => AllowsFrom(rule, port, source))
        && (string.Equals(rule.Comment, Comment, StringComparison.Ordinal)
            || wanted.Contains(source)
            || (previous?.Contains(FirewallAddresses.Format(source), StringComparer.Ordinal) ?? false));

    private static string Number(int value) => value.ToString(CultureInfo.InvariantCulture);
}
