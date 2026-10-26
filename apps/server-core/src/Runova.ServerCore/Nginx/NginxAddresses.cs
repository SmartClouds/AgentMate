using System.Diagnostics.CodeAnalysis;
using System.Globalization;
using System.Net;
using System.Net.Sockets;

namespace Runova.ServerCore.Nginx;

/// <summary>
/// Strict IP address and network parsing for anything rendered into nginx. .NET's own parser, like
/// the C library's, accepts shorthands such as <c>127.1</c>, <c>0x7f000001</c> or octal parts, so
/// the same text could name one address to a check and another to nginx. Only plain dotted IPv4
/// and plain IPv6 are accepted here, and callers render the parsed address, never the input.
/// </summary>
internal static class NginxAddresses
{
    /// <summary>Four decimal numbers from 0 to 255, no leading zeros, nothing else.</summary>
    public static bool TryParseIPv4(string text, [NotNullWhen(true)] out IPAddress? address)
    {
        address = null;
        var parts = text.Split('.');
        if (parts.Length != 4)
        {
            return false;
        }

        var bytes = new byte[4];
        for (var i = 0; i < 4; i++)
        {
            var part = parts[i];
            if (part.Length is 0 or > 3
                || !part.All(char.IsAsciiDigit)
                || (part.Length > 1 && part[0] == '0')
                || !byte.TryParse(part, NumberStyles.None, CultureInfo.InvariantCulture, out bytes[i]))
            {
                return false;
            }
        }

        address = new IPAddress(bytes);
        return true;
    }

    /// <summary>An IPv6 address without a zone index, in any of its standard spellings.</summary>
    public static bool TryParseIPv6(string text, [NotNullWhen(true)] out IPAddress? address)
    {
        address = null;
        if (!text.Contains(':', StringComparison.Ordinal)
            || !text.All(c => char.IsAsciiHexDigit(c) || c is ':' or '.')
            || !IPAddress.TryParse(text, out var parsed)
            || parsed.AddressFamily != AddressFamily.InterNetworkV6
            || parsed.ScopeId != 0)
        {
            return false;
        }

        address = parsed;
        return true;
    }

    public static bool TryParse(string text, [NotNullWhen(true)] out IPAddress? address) =>
        TryParseIPv4(text, out address) || TryParseIPv6(text, out address);

    /// <summary>
    /// An address or a network in CIDR form, for allow and deny rules. A network whose address has
    /// bits set past the prefix is refused rather than silently widened or narrowed, since nginx
    /// only warns about it and the rule would not mean what it says.
    /// </summary>
    public static bool TryParseNetwork(string text, [NotNullWhen(true)] out string? canonical, [NotNullWhen(false)] out string? problem)
    {
        canonical = null;
        var slash = text.IndexOf('/', StringComparison.Ordinal);
        var addressText = slash < 0 ? text : text[..slash];
        if (!TryParse(addressText, out var address))
        {
            problem = $"'{text}' is not an IP address or a network like 203.0.113.0/24 or 2001:db8::/32.";
            return false;
        }

        var maxPrefix = address.AddressFamily == AddressFamily.InterNetwork ? 32 : 128;
        var prefix = maxPrefix;
        if (slash >= 0)
        {
            var prefixText = text[(slash + 1)..];
            if (prefixText.Length is 0 or > 3
                || !prefixText.All(char.IsAsciiDigit)
                || (prefixText.Length > 1 && prefixText[0] == '0')
                || !int.TryParse(prefixText, NumberStyles.None, CultureInfo.InvariantCulture, out prefix)
                || prefix > maxPrefix)
            {
                problem = $"'{text}' has a prefix length that is not a number from 0 to {maxPrefix}.";
                return false;
            }
        }

        var network = new IPNetwork(Masked(address, prefix), prefix);
        if (!network.BaseAddress.Equals(address))
        {
            problem = $"'{text}' has bits set past its /{prefix} prefix; the network is {network}.";
            return false;
        }

        canonical = slash < 0 ? address.ToString() : network.ToString();
        problem = null;
        return true;
    }

    /// <summary>
    /// Why nginx must never connect to this address on a visitor's behalf, or null when it may.
    /// IPv6 forms that carry an IPv4 address (mapped, compatible, NAT64 and 6to4) are judged by
    /// the IPv4 address inside them.
    /// </summary>
    public static string? Refusal(IPAddress address)
    {
        ArgumentNullException.ThrowIfNull(address);
        if (address.AddressFamily == AddressFamily.InterNetworkV6)
        {
            var embedded = EmbeddedIPv4(address);
            if (embedded is not null)
            {
                var inner = RefusalV4(embedded);
                return inner is null ? null : $"{address} carries the IPv4 address {embedded}: {inner}";
            }

            return RefusalV6(address);
        }

        return RefusalV4(address);
    }

    private static string? RefusalV4(IPAddress address)
    {
        var b = address.GetAddressBytes();
        return b switch
        {
            [0, _, _, _] =>
                $"{address} is in 0.0.0.0/8, which is not a destination: connecting to 0.0.0.0 reaches this server's own ports.",
            [169, 254, _, _] =>
                $"{address} is link-local (169.254.0.0/16), where cloud providers run the metadata service that hands out this server's credentials.",
            [100, 100, 100, 200] =>
                $"{address} is Alibaba Cloud's metadata service, which hands out this server's credentials.",
            [168, 63, 129, 16] =>
                $"{address} is Azure's host service address (the wire server), which answers with data about this server.",
            [192, 0, 0, 192] =>
                $"{address} is Oracle Cloud's metadata service, which hands out this server's credentials.",
            [>= 224 and <= 239, _, _, _] =>
                $"{address} is a multicast address (224.0.0.0/4), which nginx cannot proxy to.",
            [>= 240, _, _, _] =>
                $"{address} is reserved (240.0.0.0/4, which includes the broadcast address 255.255.255.255).",
            _ => null,
        };
    }

    private static string? RefusalV6(IPAddress address)
    {
        var b = address.GetAddressBytes();
        if (address.Equals(IPAddress.IPv6Any))
        {
            return ":: is the unspecified address, which is not a destination: connecting to it reaches this server's own ports.";
        }

        if (b[0] == 0xfe && (b[1] & 0xc0) == 0x80)
        {
            return $"{address} is link-local (fe80::/10), which only exists on one network link and is where cloud metadata services live.";
        }

        if (b[0] == 0xff)
        {
            return $"{address} is a multicast address (ff00::/8), which nginx cannot proxy to.";
        }

        if (b is [0xfd, 0x00, 0x0e, 0xc2, ..])
        {
            return $"{address} is in fd00:ec2::/32, where AWS runs its metadata service (fd00:ec2::254) that hands out this server's credentials.";
        }

        return null;
    }

    /// <summary>The IPv4 address an IPv6 address stands for, when it is one of the forms that embed one.</summary>
    private static IPAddress? EmbeddedIPv4(IPAddress address)
    {
        var b = address.GetAddressBytes();
        if (address.IsIPv4MappedToIPv6)
        {
            return address.MapToIPv4();
        }

        // 64:ff9b::/96, the NAT64 well-known prefix: the last four bytes are the IPv4 address.
        if (b is [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0, ..])
        {
            return new IPAddress(b[12..16]);
        }

        // 2002::/16, 6to4: the next four bytes are the IPv4 address.
        if (b is [0x20, 0x02, ..])
        {
            return new IPAddress(b[2..6]);
        }

        // ::a.b.c.d, the deprecated IPv4-compatible form (but not :: or ::1 themselves).
        if (b[..12].All(x => x == 0) && !(b[12] == 0 && b[13] == 0 && b[14] == 0 && b[15] <= 1))
        {
            return new IPAddress(b[12..16]);
        }

        return null;
    }

    private static IPAddress Masked(IPAddress address, int prefix)
    {
        var bytes = address.GetAddressBytes();
        for (var i = 0; i < bytes.Length; i++)
        {
            var bits = Math.Clamp(prefix - (i * 8), 0, 8);
            bytes[i] &= (byte)(0xff << (8 - bits));
        }

        return new IPAddress(bytes);
    }
}
