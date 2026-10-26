using System.Globalization;
using System.Net;
using System.Text;
using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.Firewall;

/// <summary>
/// The rules ufw keeps in /etc/ufw/user.rules (IPv4) and user6.rules (IPv6), read from the tuple
/// line it writes above each rule:
/// <c>### tuple ### action proto dport dst sport src [dapp sapp] direction[_interface] [comment=hex]</c>.
/// A rule ufw added for both families (no address of its own) sits in both files; the two halves
/// become one rule. ufw checks each file's rules in order, so each keeps its place in both.
/// </summary>
internal static class UfwRules
{
    private const string Marker = "### tuple ###";

    public static IReadOnlyList<FirewallRule> Parse(string? v4, string? v6)
    {
        var ipv4 = ParseFile(v4, FirewallFamilies.Ipv4);
        var ipv6 = ParseFile(v6, FirewallFamilies.Ipv6);
        var claimed = new HashSet<int>();
        var rules = new List<FirewallRule>();
        foreach (var (rule, key) in ipv4)
        {
            var twin = key is null ? -1 : ipv6.FindIndex(candidate => candidate.Key == key && !claimed.Contains(candidate.Rule.Ipv6Order));
            if (twin >= 0)
            {
                claimed.Add(ipv6[twin].Rule.Ipv6Order);
                rules.Add(rule with { Families = FirewallFamilies.Both, Ipv6Order = ipv6[twin].Rule.Ipv6Order });
            }
            else
            {
                rules.Add(rule);
            }
        }

        rules.AddRange(ipv6.Where(entry => !claimed.Contains(entry.Rule.Ipv6Order)).Select(entry => entry.Rule));
        return rules;
    }

    /// <summary>
    /// The words after the action that name the rule to ufw, the same for adding it and deleting
    /// it: direction (and interface), protocol, source (and its port), destination, and the port
    /// or application profile. ufw was seen to accept each form for both.
    /// </summary>
    public static IReadOnlyList<string> Spec(FirewallRule rule)
    {
        ArgumentNullException.ThrowIfNull(rule);
        var words = new List<string> { rule.Outgoing ? "out" : "in" };
        if (rule.Interface is { } name)
        {
            words.Add("on");
            words.Add(name);
        }

        if (rule.Service is null && rule.Protocol != FirewallProtocol.Any)
        {
            words.Add("proto");
            words.Add(rule.Protocol == FirewallProtocol.Tcp ? "tcp" : "udp");
        }

        words.Add("from");
        words.Add(rule.Source is { } source ? FirewallAddresses.Format(source) : Anywhere(rule.Families));
        if (rule.SourcePort is { } sourcePort)
        {
            words.Add("port");
            words.Add(sourcePort);
        }

        words.Add("to");
        words.Add(rule.Destination is { } destination ? FirewallAddresses.Format(destination) : "any");
        if (rule.Service is { } app)
        {
            words.Add("app");
            words.Add(app);
        }
        else if (rule.PortList is { Count: > 0 } list)
        {
            words.Add("port");
            words.Add(string.Join(',', list.Select(range => range.ToUfw())));
        }
        else if (rule.Ports is { } ports)
        {
            words.Add("port");
            words.Add(ports.ToUfw());
        }

        return words;
    }

    public static string ActionWord(FirewallAction action) => action switch
    {
        FirewallAction.Allow => "allow",
        FirewallAction.Deny => "deny",
        FirewallAction.Reject => "reject",
        _ => "limit",
    };

    /// <summary>"any" makes ufw write both families; a rule for one family names that family's everything.</summary>
    private static string Anywhere(FirewallFamilies families) => families switch
    {
        FirewallFamilies.Ipv4 => "0.0.0.0/0",
        FirewallFamilies.Ipv6 => "::/0",
        _ => "any",
    };

    private static List<(FirewallRule Rule, string? Key)> ParseFile(string? text, FirewallFamilies family)
    {
        var rules = new List<(FirewallRule, string?)>();
        if (string.IsNullOrEmpty(text))
        {
            return rules;
        }

        foreach (var raw in text.Split('\n'))
        {
            var line = raw.Trim();
            if (!line.StartsWith(Marker, StringComparison.Ordinal))
            {
                continue;
            }

            if (ParseTuple(line[Marker.Length..], family, rules.Count) is { } parsed)
            {
                rules.Add(parsed);
            }
        }

        return rules;
    }

    private static (FirewallRule Rule, string? Key)? ParseTuple(string tuple, FirewallFamilies family, int order)
    {
        var tokens = tuple.Split(' ', StringSplitOptions.RemoveEmptyEntries).ToList();
        string? comment = null;
        if (tokens.Count > 0 && tokens[^1].StartsWith("comment=", StringComparison.Ordinal))
        {
            comment = DecodeComment(tokens[^1]["comment=".Length..]);
            tokens.RemoveAt(tokens.Count - 1);
        }

        if (tokens.Count is not (7 or 9))
        {
            return null;
        }

        var unknown = new List<string>();
        var readOnly = new List<string>();
        var actionText = tokens[0];
        var routed = actionText.StartsWith("route:", StringComparison.Ordinal);
        if (routed)
        {
            actionText = actionText["route:".Length..];
            unknown.Add("it applies to traffic routed through the server, not to it");
            readOnly.Add("Runova does not manage ufw's route rules");
        }

        // allow_log and allow_log-all log as well; that does not change what they match.
        FirewallAction? action = actionText.Split('_')[0] switch
        {
            "allow" => FirewallAction.Allow,
            "deny" => FirewallAction.Deny,
            "reject" => FirewallAction.Reject,
            "limit" => FirewallAction.Limit,
            _ => null,
        };
        if (action is null)
        {
            return null;
        }

        var protocol = tokens[1] switch
        {
            "tcp" => FirewallProtocol.Tcp,
            "udp" => FirewallProtocol.Udp,
            "any" => FirewallProtocol.Any,
            _ => (FirewallProtocol?)null,
        };
        if (protocol is null)
        {
            unknown.Add($"it matches the protocol {Shown(tokens[1])}");
            readOnly.Add($"it uses a protocol Runova does not manage ({Shown(tokens[1])})");
        }

        PortRange? ports = null;
        IReadOnlyList<PortRange>? portList = null;
        if (tokens[2] != "any")
        {
            if (ParsePorts(tokens[2]) is not { Count: > 0 } parsedPorts)
            {
                return null;
            }

            if (parsedPorts.Count == 1)
            {
                ports = parsedPorts[0];
            }
            else
            {
                portList = parsedPorts;
            }
        }

        if (!TryAddress(tokens[3], out var destination) || !TryAddress(tokens[5], out var source))
        {
            return null;
        }

        string? sourcePort = null;
        if (tokens[4] != "any")
        {
            if (ParsePorts(tokens[4]) is not { Count: > 0 })
            {
                return null;
            }

            sourcePort = tokens[4];
            unknown.Add($"it only matches traffic from source port {sourcePort}");
        }

        string? service = null;
        string? sourceApp = null;
        if (tokens.Count == 9)
        {
            service = tokens[6] == "-" ? null : App(tokens[6]);
            sourceApp = tokens[7] == "-" ? null : App(tokens[7]);
            if (sourceApp is not null)
            {
                unknown.Add($"it matches traffic from the application profile {sourceApp}");
                readOnly.Add("it names an application profile as its source");
            }
        }

        var direction = tokens[^1];
        var underscore = direction.IndexOf('_', StringComparison.Ordinal);
        var interfaceName = underscore < 0 ? null : direction[(underscore + 1)..];
        var outgoing = (underscore < 0 ? direction : direction[..underscore]) == "out";
        if (interfaceName is { Length: 0 })
        {
            return null;
        }

        var rule = new FirewallRule
        {
            Action = action.Value,
            Shape = "ufw",
            Protocol = protocol ?? FirewallProtocol.Any,
            Ports = ports,
            PortList = portList,
            Source = source,
            Destination = destination,
            SourcePort = sourcePort,
            Families = family,
            Comment = comment,
            Service = service,
            SourceApp = sourceApp,
            Interface = interfaceName,
            Outgoing = outgoing,
            Routed = routed,
            Unknown = unknown.Count == 0 ? null : string.Join("; ", unknown),
            ReadOnlyReason = readOnly.Count == 0 ? null : string.Join("; ", readOnly),
            Ipv4Order = order,
            Ipv6Order = order,
        };

        // Only a rule without an address of its own can have a twin in the other family's file.
        var key = source is null && destination is null ? string.Join(' ', tokens.Where((_, index) => index is not (3 or 5))) + "|" + comment : null;
        return (rule, key);
    }

    /// <summary>"22", "6000:6007" or a list of either ("80,443,8000:8080").</summary>
    private static List<PortRange>? ParsePorts(string text)
    {
        var ranges = new List<PortRange>();
        foreach (var part in text.Split(','))
        {
            var bounds = part.Split(':');
            if (bounds.Length is not (1 or 2)
                || !int.TryParse(bounds[0], NumberStyles.None, CultureInfo.InvariantCulture, out var from)
                || !int.TryParse(bounds[^1], NumberStyles.None, CultureInfo.InvariantCulture, out var to)
                || from is < 1 or > 65535 || to < from || to > 65535)
            {
                return null;
            }

            ranges.Add(new PortRange(from, to));
        }

        return ranges;
    }

    /// <summary>0.0.0.0/0 and ::/0 are ufw's "any"; anything else is an address or network.</summary>
    private static bool TryAddress(string text, out IPNetwork? network)
    {
        network = null;
        if (text is "0.0.0.0/0" or "::/0" or "any")
        {
            return true;
        }

        if (!FirewallAddresses.TryParseNetwork(text, out var parsed, out _))
        {
            return false;
        }

        network = parsed;
        return true;
    }

    /// <summary>ufw writes comments as hex-encoded UTF-8, so a comment can hold anything.</summary>
    private static string? DecodeComment(string hex)
    {
        try
        {
            var text = Encoding.UTF8.GetString(Convert.FromHexString(hex));
            return text.Length == 0 ? null : text;
        }
        catch (FormatException)
        {
            return null;
        }
    }

    /// <summary>ufw writes a space in a profile name as %20.</summary>
    private static string App(string text) => text.Replace("%20", " ", StringComparison.Ordinal);

    private static string Shown(string text) => text.Length <= 20 ? text : text[..20] + "…";
}
