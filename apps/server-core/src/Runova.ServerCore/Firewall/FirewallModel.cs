using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.Firewall;

/// <summary>
/// A change the core refuses, with the reason in words the person can act on. Verdict is set when
/// the lockout guard refused it; NeedsStepUp when entering the password again would let it through.
/// </summary>
internal sealed class FirewallRefusedException(string message, FirewallGuardVerdict? verdict = null, bool needsStepUp = false)
    : Exception(message)
{
    public FirewallGuardVerdict? Verdict { get; } = verdict;

    public bool NeedsStepUp { get; } = needsStepUp;
}

/// <summary>One port or an inclusive range.</summary>
internal readonly record struct PortRange(int From, int To)
{
    public bool IsSingle => From == To;

    public bool Contains(int port) => port >= From && port <= To;

    /// <summary>"22" or "6000-6007".</summary>
    public override string ToString() => IsSingle
        ? From.ToString(CultureInfo.InvariantCulture)
        : $"{From.ToString(CultureInfo.InvariantCulture)}-{To.ToString(CultureInfo.InvariantCulture)}";

    /// <summary>"22" or "6000:6007", as ufw writes ranges.</summary>
    public string ToUfw() => IsSingle
        ? From.ToString(CultureInfo.InvariantCulture)
        : $"{From.ToString(CultureInfo.InvariantCulture)}:{To.ToString(CultureInfo.InvariantCulture)}";
}

/// <summary>
/// One rule of the host firewall, in a form both backends map onto. Fields the core can rely on
/// (family, protocol, ports, addresses, interface, direction) are kept as values; anything else
/// about the rule that changes whether it matches is described in <see cref="Unknown"/>, and the
/// lockout guard then treats the rule as one that might match.
/// </summary>
internal sealed record FirewallRule
{
    public required FirewallAction Action { get; init; }

    /// <summary>How the backend holds it: "ufw", or firewalld's "port", "service", "rich", "protocol".</summary>
    public required string Shape { get; init; }

    public FirewallProtocol Protocol { get; init; }

    /// <summary>Null: every port (unless <see cref="PortList"/> names several).</summary>
    public PortRange? Ports { get; init; }

    /// <summary>ufw's `port 80,443`: several ports or ranges in one rule. Ports is null then.</summary>
    public IReadOnlyList<PortRange>? PortList { get; init; }

    /// <summary>Null: from anywhere.</summary>
    public IPNetwork? Source { get; init; }

    /// <summary>firewalld's `source NOT address`: from anywhere but <see cref="Source"/>.</summary>
    public bool SourceNegated { get; init; }

    public FirewallFamilies Families { get; init; }

    public string? Comment { get; init; }

    /// <summary>A firewalld service or a ufw application profile the rule was made from.</summary>
    public string? Service { get; init; }

    /// <summary>ufw `in on eth0`.</summary>
    public string? Interface { get; init; }

    /// <summary>ufw `to 10.0.0.5`: only traffic to that address of the server.</summary>
    public IPNetwork? Destination { get; init; }

    /// <summary>A ufw rule for outgoing traffic. Listed, never matched against a connection in.</summary>
    public bool Outgoing { get; init; }

    /// <summary>A ufw route rule (forwarded traffic). Listed, never matched against a connection to the server.</summary>
    public bool Routed { get; init; }

    /// <summary>A firewalld rich rule's priority: below zero runs before the rest, above zero after.</summary>
    public int Priority { get; init; }

    /// <summary>What about the rule the core cannot evaluate (a rate limit, a source port), or null.</summary>
    public string? Unknown { get; init; }

    /// <summary>Why the core will not change this rule, or null when it can.</summary>
    public string? ReadOnlyReason { get; init; }

    /// <summary>The backend's own text, used to remove the rule (a rich rule, "8080/tcp", a service).</summary>
    public string? Native { get; init; }

    /// <summary>ufw: the source port field when it is not "any" (kept so the rule can be deleted exactly).</summary>
    public string? SourcePort { get; init; }

    /// <summary>ufw: the source application profile, when there is one.</summary>
    public string? SourceApp { get; init; }

    /// <summary>ufw checks each family's list in order, first match wins; this is the place in each.</summary>
    public int Ipv4Order { get; init; }

    public int Ipv6Order { get; init; }

    public bool Editable => ReadOnlyReason is null;

    public bool CoversIpv4 => Families is FirewallFamilies.Both or FirewallFamilies.Ipv4;

    public bool CoversIpv6 => Families is FirewallFamilies.Both or FirewallFamilies.Ipv6;

    /// <summary>"22", "6000-6007" or "80,443"; null for every port.</summary>
    public string? PortsText => PortList is { Count: > 0 } list ? string.Join(',', list) : Ports?.ToString();

    /// <summary>
    /// The same rule gets the same id on every read, so a change can name it. What it does decides
    /// the id, not where it sits or its comment (ufw itself ignores comments when deleting).
    /// </summary>
    public string Id
    {
        get
        {
            var key = string.Join(
                '|',
                Shape,
                Action,
                Protocol,
                PortsText ?? "*",
                (SourceNegated ? "!" : string.Empty) + (Source?.ToString() ?? "*"),
                Families,
                Service ?? string.Empty,
                Interface ?? string.Empty,
                Destination?.ToString() ?? "*",
                Outgoing ? "out" : Routed ? "route" : "in",
                Priority.ToString(CultureInfo.InvariantCulture),
                SourcePort ?? string.Empty,
                SourceApp ?? string.Empty,
                Unknown is null ? string.Empty : Native ?? Unknown);
            return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(key)))[..16];
        }
    }
}

/// <summary>The firewall as a backend read it, or as a change set would leave it.</summary>
internal sealed record FirewallState
{
    public required FirewallBackendKind Backend { get; init; }

    public bool Installed { get; init; } = true;

    public bool Active { get; init; }

    public FirewallPolicy DefaultIncoming { get; init; } = FirewallPolicy.Deny;

    public FirewallPolicy DefaultOutgoing { get; init; } = FirewallPolicy.Allow;

    /// <summary>ufw: IPV6=yes in /etc/default/ufw. firewalld always filters both families.</summary>
    public bool Ipv6 { get; init; } = true;

    /// <summary>firewalld: the zone the core manages (the default zone).</summary>
    public string? Zone { get; init; }

    /// <summary>In the order the backend lists them.</summary>
    public IReadOnlyList<FirewallRule> Rules { get; init; } = [];

    public IReadOnlyList<string> Warnings { get; init; } = [];

    /// <summary>Why the backend takes no change right now (firewalld running unsaved rules), or null.</summary>
    public string? RefusalReason { get; init; }
}

/// <summary>A new connection in: from an address to one of the server's ports.</summary>
internal readonly record struct Probe(IPAddress Source, int Port, FirewallProtocol Protocol, IPAddress? Destination = null);

internal enum RuleMatch
{
    No,
    Yes,

    /// <summary>The rule might match: it depends on something the core cannot see (an interface, a rate limit).</summary>
    Maybe,
}

/// <summary>
/// Whether a connection would get in and what decided it. Verb says what happens to a blocked
/// one: "dropped", "refused" (a reject), or "blocked" when the core cannot tell exactly.
/// </summary>
internal sealed record FirewallVerdict(bool Allowed, string Reason, FirewallRule? Rule = null, string Verb = "blocked");
