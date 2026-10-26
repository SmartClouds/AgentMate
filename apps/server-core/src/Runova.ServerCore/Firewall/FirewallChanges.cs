using System.Globalization;
using System.Net;
using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.Firewall;

/// <summary>A checked change set and the firewall it would leave behind.</summary>
internal sealed record FirewallChangePlan(
    FirewallState Current,
    FirewallState Result,
    IReadOnlyList<FirewallChange> Changes,
    IReadOnlyList<FirewallRule> Added,
    IReadOnlyList<FirewallRule> Removed,
    FirewallPolicy? DefaultIncoming,
    bool? Enable,
    IReadOnlyList<string> Notes,
    string Summary)
{
    /// <summary>Turning the firewall on or off needs a step-up; overriding the guard does too (checked apart).</summary>
    public bool NeedsStepUp => Enable is not null;
}

/// <summary>
/// Checks a change set against the firewall as it is and works out the result, without touching
/// the server. Everything a change set may hold is checked here, once, for every backend.
/// </summary>
/// <remarks>
/// New rules land where both backends give them the same meaning: ufw lets the first matching
/// rule decide, so an allow goes last and a deny or reject first (ufw's prepend); firewalld runs
/// its denies before its allows by itself. Either way a deny beats an allow.
/// </remarks>
internal static class FirewallChangePlanner
{
    public const int MaxChanges = 50;

    public const int MaxCommentLength = 64;

    public static FirewallChangePlan Plan(FirewallState current, IReadOnlyList<FirewallChange>? changes)
    {
        ArgumentNullException.ThrowIfNull(current);
        if (current.Backend == FirewallBackendKind.None || !current.Installed)
        {
            throw new FirewallRefusedException(
                "Neither ufw nor firewalld is installed on this server, so there is no firewall to change. "
                + "Install ufw (Ubuntu, Debian) or firewalld (the RHEL family) first.");
        }

        if (current.RefusalReason is { } reason)
        {
            throw new FirewallRefusedException(reason);
        }

        if (changes is null || changes.Count is 0 or > MaxChanges)
        {
            throw new FirewallRefusedException($"A change set has 1 to {MaxChanges} changes.");
        }

        var notes = new List<string>();
        var ipv6 = current.Ipv6;
        if (current.Backend == FirewallBackendKind.Ufw && !current.Ipv6)
        {
            ipv6 = true;
            notes.Add(
                "ufw was not filtering IPv6 (IPV6=no in /etc/default/ufw). This change turns IPv6 filtering on, so IPv6 "
                + "traffic follows the rules from now on; rules made before it cover IPv4 only.");
        }

        var rules = current.Rules.ToList();
        var added = new List<FirewallRule>();
        var removed = new List<FirewallRule>();
        var summary = new List<string>();
        FirewallPolicy? incoming = null;
        bool? enable = null;

        foreach (var change in changes)
        {
            if (change is null)
            {
                throw new FirewallRefusedException("A change set cannot hold an empty change.");
            }

            switch (change.Kind)
            {
                case FirewallChangeKind.AddRule:
                    {
                        var rule = Validate(change.Rule, current.Backend, notes);
                        summary.Add(FirewallEvaluation.Describe(rule with { Families = FamiliesOf(rule, ipv6) }));
                        foreach (var made in Expand(rule, current.Backend))
                        {
                            var placed = made with { Families = FamiliesOf(made, ipv6) };
                            if (rules.Any(existing => existing.Id == placed.Id))
                            {
                                notes.Add($"\"{FirewallEvaluation.Describe(placed)}\" is already there, so adding it changes nothing.");
                                continue;
                            }

                            placed = Place(rules, placed, current.Backend);
                            if (current.Backend == FirewallBackendKind.Ufw && FirewallEvaluation.Blocks(placed))
                            {
                                rules.Insert(0, placed);
                            }
                            else
                            {
                                rules.Add(placed);
                            }

                            added.Add(placed);
                        }

                        break;
                    }

                case FirewallChangeKind.RemoveRule:
                    {
                        var existing = rules.FirstOrDefault(rule => rule.Id == change.RuleId)
                            ?? throw new FirewallRefusedException(
                                "There is no rule with that id any more: the firewall changed since it was read. Refresh it and try again.");
                        if (!existing.Editable)
                        {
                            throw new FirewallRefusedException(
                                $"\"{FirewallEvaluation.Describe(existing)}\" cannot be changed from Runova: {existing.ReadOnlyReason}. "
                                + "Change it on the server itself.");
                        }

                        rules.Remove(existing);
                        removed.Add(existing);
                        summary.Add($"remove \"{FirewallEvaluation.Describe(existing)}\"");
                        break;
                    }

                case FirewallChangeKind.SetDefaultIncoming:
                    if (change.Policy is not { } policy || !Enum.IsDefined(policy))
                    {
                        throw new FirewallRefusedException(
                            "Setting the default for incoming traffic needs a policy: allow, deny or reject.");
                    }

                    if (incoming is not null)
                    {
                        throw new FirewallRefusedException("Set the default for incoming traffic once per change set.");
                    }

                    incoming = policy;
                    summary.Add($"set the default for incoming traffic to {FirewallEvaluation.Word(policy)}");
                    break;

                case FirewallChangeKind.Enable:
                case FirewallChangeKind.Disable:
                    {
                        var on = change.Kind == FirewallChangeKind.Enable;
                        if (enable is not null)
                        {
                            throw new FirewallRefusedException(enable == on
                                ? $"Turn the firewall {(on ? "on" : "off")} once per change set."
                                : "A change set turns the firewall on or off, not both.");
                        }

                        enable = on;
                        summary.Add(on ? "turn the firewall on" : "turn the firewall off");
                        break;
                    }

                default:
                    throw new FirewallRefusedException("That is not a change the core knows: add or remove a rule, set the default, or turn the firewall on or off.");
            }
        }

        var result = current with
        {
            Active = enable ?? current.Active,
            DefaultIncoming = incoming ?? current.DefaultIncoming,
            Ipv6 = ipv6,
            Rules = rules,
        };
        return new FirewallChangePlan(current, result, [.. changes], added, removed, incoming, enable, notes, Sentence(summary));
    }

    /// <summary>The rule a spec asks for, checked; Families is set when it is placed.</summary>
    private static FirewallRule Validate(FirewallRuleSpec? spec, FirewallBackendKind backend, List<string> notes)
    {
        if (spec is null)
        {
            throw new FirewallRefusedException("Adding a rule needs a rule: what to allow or block.");
        }

        if (!Enum.IsDefined(spec.Action))
        {
            throw new FirewallRefusedException("That is not an action: use allow, deny, reject or limit.");
        }

        if (!Enum.IsDefined(spec.Protocol))
        {
            throw new FirewallRefusedException("That is not a protocol: use TCP, UDP or any.");
        }

        if (spec.Action == FirewallAction.Limit && backend != FirewallBackendKind.Ufw)
        {
            throw new FirewallRefusedException(
                "Limit (refusing an address that opens six connections within 30 seconds) is something only ufw does. Use allow here.");
        }

        PortRange? ports = null;
        if (spec.Port is int from)
        {
            var to = spec.PortTo ?? from;
            if (from is < 1 or > 65535 || to is < 1 or > 65535)
            {
                throw new FirewallRefusedException("A port is a number from 1 to 65535.");
            }

            if (to < from)
            {
                throw new FirewallRefusedException("A port range runs from a lower port to a higher one.");
            }

            ports = new PortRange(from, to);
            if (!ports.Value.IsSingle && spec.Protocol == FirewallProtocol.Any)
            {
                throw new FirewallRefusedException(
                    "A port range needs TCP or UDP: ufw and firewalld both refuse a range for every protocol. Add one rule for each.");
            }
        }
        else if (spec.PortTo is not null)
        {
            throw new FirewallRefusedException("A port range needs its first port as well as its last.");
        }

        IPNetwork? source = null;
        var families = FirewallFamilies.Both;
        if (spec.Source is not null)
        {
            if (!FirewallAddresses.TryParseNetwork(spec.Source, out var network, out var error))
            {
                throw new FirewallRefusedException(error);
            }

            families = FirewallAddresses.IsIpv6(network) ? FirewallFamilies.Ipv6 : FirewallFamilies.Ipv4;
            // 0.0.0.0/0 and ::/0 are "anywhere" for one family, which is how both backends store them.
            source = FirewallAddresses.IsEverything(network) ? null : network;
        }

        if (ports is null && spec.Source is null)
        {
            throw new FirewallRefusedException(
                "A rule without a port covers every port, so it needs a source address. To open every port to everyone, "
                + "set the default for incoming traffic to allow instead.");
        }

        var comment = spec.Comment?.Trim();
        if (comment is { Length: 0 })
        {
            comment = null;
        }

        if (comment is not null && (comment.Length > MaxCommentLength || comment.Any(char.IsControl)))
        {
            throw new FirewallRefusedException(
                $"Comments have at most {MaxCommentLength.ToString(CultureInfo.InvariantCulture)} characters and no line breaks or control characters.");
        }

        if (comment is not null && backend == FirewallBackendKind.Firewalld)
        {
            notes.Add($"firewalld keeps no comments on rules, so \"{comment}\" is not saved with it.");
            comment = null;
        }

        var shape = backend == FirewallBackendKind.Ufw
            ? "ufw"
            : spec.Action == FirewallAction.Allow && source is null && ports is not null && families == FirewallFamilies.Both
                ? "port"
                : "rich";
        return new FirewallRule
        {
            Action = spec.Action,
            Shape = shape,
            Protocol = spec.Protocol,
            Ports = ports,
            Source = source,
            Families = families,
            Comment = comment,
        };
    }

    /// <summary>firewalld holds a port (and a rich rule's port) for one protocol, so "any" becomes TCP and UDP.</summary>
    private static IEnumerable<FirewallRule> Expand(FirewallRule rule, FirewallBackendKind backend)
    {
        if (backend == FirewallBackendKind.Firewalld && rule.Protocol == FirewallProtocol.Any && rule.Ports is not null)
        {
            yield return rule with { Protocol = FirewallProtocol.Tcp };
            yield return rule with { Protocol = FirewallProtocol.Udp };
            yield break;
        }

        yield return rule;
    }

    /// <summary>
    /// A rule's families as the backend will store it: both when it names no family, except where
    /// ufw does not filter IPv6, which keeps it to IPv4.
    /// </summary>
    private static FirewallFamilies FamiliesOf(FirewallRule rule, bool ipv6) =>
        rule.Families == FirewallFamilies.Both && !ipv6 ? FirewallFamilies.Ipv4 : rule.Families;

    /// <summary>ufw: an allow after every rule of its families, a deny or reject before them.</summary>
    private static FirewallRule Place(List<FirewallRule> rules, FirewallRule rule, FirewallBackendKind backend)
    {
        if (backend != FirewallBackendKind.Ufw)
        {
            return rule;
        }

        var first = FirewallEvaluation.Blocks(rule);
        int Next(IEnumerable<int> orders) => first
            ? orders.DefaultIfEmpty(0).Min() - 1
            : orders.DefaultIfEmpty(-1).Max() + 1;

        return rule with
        {
            Ipv4Order = Next(rules.Where(existing => existing.CoversIpv4).Select(existing => existing.Ipv4Order)),
            Ipv6Order = Next(rules.Where(existing => existing.CoversIpv6).Select(existing => existing.Ipv6Order)),
        };
    }

    private static string Sentence(List<string> parts)
    {
        var text = string.Join("; ", parts.Select((part, index) => index == 0 ? part : Lower(part)));
        return text.Length == 0 ? text : char.ToUpperInvariant(text[0]) + text[1..];
    }

    private static string Lower(string text) =>
        text.Length > 0 && char.IsUpper(text[0]) && (text.Length == 1 || !char.IsUpper(text[1]))
            ? char.ToLowerInvariant(text[0]) + text[1..]
            : text;
}
