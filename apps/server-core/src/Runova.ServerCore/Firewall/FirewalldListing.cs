using System.Globalization;
using System.Net;
using System.Text;
using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.Firewall;

/// <summary>A zone as `firewall-cmd --list-all` prints it.</summary>
internal sealed record FirewalldZone(string Name, IReadOnlyDictionary<string, string> Fields, IReadOnlyList<string> RichRules)
{
    public string Value(string key) => Fields.GetValueOrDefault(key, string.Empty);

    public IReadOnlyList<string> Words(string key) => Value(key).Split(' ', StringSplitOptions.RemoveEmptyEntries);

    /// <summary>
    /// What decides traffic, to compare the running zone with its saved one. Interfaces and sources
    /// are left out (Docker and NetworkManager bind them at runtime), and so is the order of the
    /// rich rules, which firewalld lists differently at runtime.
    /// </summary>
    public string Comparable()
    {
        var text = new StringBuilder();
        foreach (var key in new[] { "target", "icmp-block-inversion", "services", "ports", "protocols", "forward", "masquerade", "forward-ports", "source-ports", "icmp-blocks" })
        {
            text.Append(key).Append('=').Append(string.Join(' ', Words(key).Order(StringComparer.Ordinal))).Append('\n');
        }

        foreach (var rule in RichRules.Order(StringComparer.Ordinal))
        {
            text.Append(rule).Append('\n');
        }

        return text.ToString();
    }
}

/// <summary>
/// Reading firewalld's listings: a zone's --list-all, a service's --info-service, and rich rules,
/// which become rules the planner and the lockout guard understand. Anything about a rich rule the
/// core cannot evaluate is written into the rule's Unknown, so the guard assumes the worst of it.
/// </summary>
internal static class FirewalldListing
{
    public static FirewalldZone ParseZone(string output)
    {
        ArgumentNullException.ThrowIfNull(output);
        var lines = output.Split('\n');
        var name = lines.FirstOrDefault()?.Trim().Split(' ')[0] ?? string.Empty;
        var fields = new Dictionary<string, string>(StringComparer.Ordinal);
        var rich = new List<string>();
        foreach (var raw in lines.Skip(1))
        {
            var line = raw.Trim();
            if (line.StartsWith("rule ", StringComparison.Ordinal) || line == "rule")
            {
                rich.Add(line);
                continue;
            }

            var colon = line.IndexOf(':', StringComparison.Ordinal);
            if (colon > 0)
            {
                fields[line[..colon]] = line[(colon + 1)..].Trim();
            }
        }

        return new FirewalldZone(name, fields, rich);
    }

    /// <summary>
    /// The rules a zone's service opens: one rule for a service with one port, which the core can
    /// remove; a read-only rule per port for a service with several (removing one would remove all).
    /// </summary>
    public static IReadOnlyList<FirewallRule> Service(string name, string? info)
    {
        ArgumentNullException.ThrowIfNull(name);
        var ports = info is null ? null : Ports(info);
        if (ports is null || ports.Count == 0)
        {
            return
            [
                new FirewallRule
                {
                    Action = FirewallAction.Allow,
                    Shape = "service",
                    Protocol = FirewallProtocol.Any,
                    Service = name,
                    Native = name,
                    Families = FirewallFamilies.Both,
                    Unknown = ports is null ? "the core could not read which ports this service opens" : "this service opens no plain port",
                    ReadOnlyReason = "Runova cannot tell what this service opens",
                },
            ];
        }

        if (ports.Count == 1)
        {
            return [ServiceRule(name, ports[0].Ports, ports[0].Protocol, null)];
        }

        var reason = $"it comes from the {name} service, which opens several ports; remove it on the server with firewall-cmd --permanent --remove-service={name}";
        return [.. ports.Select(port => ServiceRule(name, port.Ports, port.Protocol, reason))];
    }

    /// <summary>The ports line of `--info-service`: "22/tcp", "139/tcp 445/tcp".</summary>
    public static IReadOnlyList<(PortRange Ports, FirewallProtocol Protocol)>? Ports(string info)
    {
        ArgumentNullException.ThrowIfNull(info);
        foreach (var raw in info.Split('\n'))
        {
            var line = raw.Trim();
            if (!line.StartsWith("ports:", StringComparison.Ordinal))
            {
                continue;
            }

            var ports = new List<(PortRange, FirewallProtocol)>();
            foreach (var word in line["ports:".Length..].Split(' ', StringSplitOptions.RemoveEmptyEntries))
            {
                if (PortWord(word) is not { } port)
                {
                    return null;
                }

                ports.Add(port);
            }

            return ports;
        }

        return [];
    }

    /// <summary>"8080/tcp" or "6000-6007/udp". Other protocols (sctp, dccp) are not ports the core manages.</summary>
    public static (PortRange Ports, FirewallProtocol Protocol)? PortWord(string word)
    {
        var slash = word.IndexOf('/', StringComparison.Ordinal);
        if (slash <= 0)
        {
            return null;
        }

        var protocol = word[(slash + 1)..] switch
        {
            "tcp" => FirewallProtocol.Tcp,
            "udp" => FirewallProtocol.Udp,
            _ => (FirewallProtocol?)null,
        };
        var range = Range(word[..slash]);
        return protocol is null || range is null ? null : (range.Value, protocol.Value);
    }

    /// <summary>
    /// A rich rule, or null when it accepts, rejects or drops nothing (a log-only rule, a forward,
    /// an ICMP block): those decide no connection in. <paramref name="services"/> gives a
    /// one-port service's port.
    /// </summary>
    public static FirewallRule? RichRule(string text, Func<string, (PortRange Ports, FirewallProtocol Protocol)?> services)
    {
        ArgumentNullException.ThrowIfNull(text);
        ArgumentNullException.ThrowIfNull(services);
        var tokens = Tokens(text.Trim());
        if (tokens is null || tokens.Count == 0 || tokens[0].Key != "rule")
        {
            return null;
        }

        FirewallAction? action = null;
        var families = FirewallFamilies.Both;
        var priority = 0;
        IPNetwork? source = null;
        var negated = false;
        IPNetwork? destination = null;
        PortRange? ports = null;
        var protocol = FirewallProtocol.Any;
        string? service = null;
        var unknown = new List<string>();
        string? element = null;
        var not = false;

        foreach (var (key, value) in tokens.Skip(1))
        {
            if (value is null)
            {
                switch (key)
                {
                    case "NOT":
                        not = true;
                        continue;
                    case "accept":
                        action = FirewallAction.Allow;
                        break;
                    case "reject":
                        action = FirewallAction.Reject;
                        break;
                    case "drop":
                        action = FirewallAction.Deny;
                        break;
                    case "icmp-block" or "icmp-type" or "masquerade" or "forward-port" or "mark":
                        return null;
                    case "source" or "destination" or "service" or "port" or "protocol" or "source-port" or "log" or "nflog" or "audit" or "limit":
                        break;
                    default:
                        return null;
                }

                if (key == "limit" && element is not ("log" or "nflog" or "audit"))
                {
                    unknown.Add("it has a rate limit");
                }

                // A limit belongs to the element before it and leaves it as the current one.
                if (key != "limit")
                {
                    element = key;
                }

                continue;
            }

            switch (element, key)
            {
                case (null, "family"):
                    families = value switch
                    {
                        "ipv4" => FirewallFamilies.Ipv4,
                        "ipv6" => FirewallFamilies.Ipv6,
                        _ => FirewallFamilies.Both,
                    };
                    break;
                case (null, "priority"):
                    if (!int.TryParse(value, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out priority))
                    {
                        return null;
                    }

                    break;
                case ("source", "address"):
                    if (!FirewallAddresses.TryParseNetwork(value, out var from, out _))
                    {
                        unknown.Add($"its source {value} could not be read");
                        break;
                    }

                    source = from;
                    negated = not;
                    break;
                case ("source", "ipset"):
                    unknown.Add($"it matches the sources in an ipset ({value})");
                    break;
                case ("source", "mac"):
                    unknown.Add($"it matches a MAC address ({value})");
                    break;
                case ("destination", "address"):
                    if (not || !FirewallAddresses.TryParseNetwork(value, out var to, out _))
                    {
                        unknown.Add($"it matches the destination {value}");
                        break;
                    }

                    destination = to;
                    break;
                case ("destination", "ipset"):
                    unknown.Add($"it matches the destinations in an ipset ({value})");
                    break;
                case ("service", "name"):
                    service = value;
                    if (services(value) is { } port)
                    {
                        ports = port.Ports;
                        protocol = port.Protocol;
                    }
                    else
                    {
                        unknown.Add($"the core could not read which port the {value} service opens");
                    }

                    break;
                case ("port", "port"):
                    if (Range(value) is not { } range)
                    {
                        return null;
                    }

                    ports = range;
                    break;
                case ("port", "protocol"):
                    protocol = value switch
                    {
                        "tcp" => FirewallProtocol.Tcp,
                        "udp" => FirewallProtocol.Udp,
                        _ => FirewallProtocol.Any,
                    };
                    if (protocol == FirewallProtocol.Any)
                    {
                        unknown.Add($"it matches the protocol {value}");
                    }

                    break;
                case ("protocol", "value"):
                    unknown.Add($"it matches the protocol {value}");
                    break;
                case ("source-port", "port"):
                    unknown.Add($"it only matches traffic from source port {value}");
                    break;
                default:
                    // Attributes of log, audit, reject (type) and the like change nothing about matching.
                    break;
            }

            not = false;
        }

        if (action is null)
        {
            return null;
        }

        return new FirewallRule
        {
            Action = action.Value,
            Shape = "rich",
            Protocol = protocol,
            Ports = ports,
            Source = source,
            SourceNegated = negated && source is not null,
            Destination = destination,
            Families = families,
            Service = service,
            Priority = priority,
            Native = text.Trim(),
            Unknown = unknown.Count == 0 ? null : string.Join("; ", unknown.Distinct()),
        };
    }

    /// <summary>The rich rule firewalld will list back for a rule the planner made.</summary>
    public static string RichText(FirewallRule rule)
    {
        ArgumentNullException.ThrowIfNull(rule);
        var words = new List<string> { "rule" };
        if (rule.Families != FirewallFamilies.Both)
        {
            words.Add(rule.Families == FirewallFamilies.Ipv4 ? "family=\"ipv4\"" : "family=\"ipv6\"");
        }

        if (rule.Source is { } source)
        {
            words.Add($"source address=\"{FirewallAddresses.Format(source)}\"");
        }

        if (rule.Ports is { } ports)
        {
            words.Add($"port port=\"{ports}\" protocol=\"{(rule.Protocol == FirewallProtocol.Udp ? "udp" : "tcp")}\"");
        }

        words.Add(rule.Action switch
        {
            FirewallAction.Allow => "accept",
            FirewallAction.Reject => "reject",
            _ => "drop",
        });
        return string.Join(' ', words);
    }

    private static FirewallRule ServiceRule(string name, PortRange ports, FirewallProtocol protocol, string? readOnly) => new()
    {
        Action = FirewallAction.Allow,
        Shape = "service",
        Protocol = protocol,
        Ports = ports,
        Service = name,
        Native = name,
        Families = FirewallFamilies.Both,
        ReadOnlyReason = readOnly,
    };

    private static PortRange? Range(string text)
    {
        var parts = text.Split('-');
        return parts.Length is 1 or 2
            && int.TryParse(parts[0], NumberStyles.None, CultureInfo.InvariantCulture, out var from)
            && int.TryParse(parts[^1], NumberStyles.None, CultureInfo.InvariantCulture, out var to)
            && from is >= 1 and <= 65535 && to >= from && to <= 65535
            ? new PortRange(from, to)
            : null;
    }

    /// <summary>Words and key="value" pairs; a quoted value may hold spaces. Null when a quote is left open.</summary>
    private static List<(string Key, string? Value)>? Tokens(string text)
    {
        var tokens = new List<(string, string?)>();
        var i = 0;
        while (i < text.Length)
        {
            if (char.IsWhiteSpace(text[i]))
            {
                i++;
                continue;
            }

            var start = i;
            while (i < text.Length && !char.IsWhiteSpace(text[i]) && text[i] != '=')
            {
                i++;
            }

            var key = text[start..i];
            if (i < text.Length && text[i] == '=')
            {
                i++;
                string value;
                if (i < text.Length && text[i] == '"')
                {
                    var close = text.IndexOf('"', i + 1);
                    if (close < 0)
                    {
                        return null;
                    }

                    value = text[(i + 1)..close];
                    i = close + 1;
                }
                else
                {
                    var valueStart = i;
                    while (i < text.Length && !char.IsWhiteSpace(text[i]))
                    {
                        i++;
                    }

                    value = text[valueStart..i];
                }

                tokens.Add((key, value));
            }
            else
            {
                tokens.Add((key, null));
            }
        }

        return tokens;
    }
}
