using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Text.RegularExpressions;

namespace Runova.ServerCore.Firewall;

/// <summary>
/// Addresses and networks in rules, read strictly: dotted quads with four parts (IPAddress.Parse
/// also takes "127.1" and hex), IPv6 without a zone, a prefix without leading zeros, and no host
/// bits past the prefix. Hosts are written without a prefix, the way ufw and firewalld show them.
/// </summary>
internal static partial class FirewallAddresses
{
    private const int MaxLength = 64;

    public static bool TryParseNetwork(string? text, out IPNetwork network, out string error)
    {
        network = default;
        var trimmed = text?.Trim() ?? string.Empty;
        if (trimmed.Length == 0)
        {
            error = "The source is empty: give an address such as 203.0.113.7 or a network such as 10.0.0.0/8.";
            return false;
        }

        if (trimmed.Length > MaxLength)
        {
            error = $"'{Shown(trimmed)}' is not an IP address or network (such as 203.0.113.7 or 10.0.0.0/8).";
            return false;
        }

        if (trimmed.Contains('%', StringComparison.Ordinal))
        {
            error = $"'{Shown(trimmed)}' names a zone (the part after %). Firewall rules take the address alone.";
            return false;
        }

        if (!NetworkCharacters().IsMatch(trimmed))
        {
            error = $"'{Shown(trimmed)}' is not an IP address or network (such as 203.0.113.7 or 10.0.0.0/8).";
            return false;
        }

        var slash = trimmed.IndexOf('/', StringComparison.Ordinal);
        var addressText = slash < 0 ? trimmed : trimmed[..slash];
        if (!TryParseAddress(addressText, out var address))
        {
            if (IPAddress.TryParse(addressText, out var loose) && loose.IsIPv4MappedToIPv6)
            {
                error = $"'{Shown(trimmed)}' is an IPv4 address in IPv6 form. Write it as {loose.MapToIPv4()}.";
                return false;
            }

            error = $"'{Shown(trimmed)}' is not an IP address or network (such as 203.0.113.7 or 10.0.0.0/8).";
            return false;
        }

        if (address.IsIPv4MappedToIPv6)
        {
            error = $"'{Shown(trimmed)}' is an IPv4 address in IPv6 form. Write it as {address.MapToIPv4()}.";
            return false;
        }

        var bits = address.AddressFamily == AddressFamily.InterNetworkV6 ? 128 : 32;
        var prefix = bits;
        if (slash >= 0)
        {
            var prefixText = trimmed[(slash + 1)..];
            if (!Prefix().IsMatch(prefixText)
                || !int.TryParse(prefixText, NumberStyles.None, CultureInfo.InvariantCulture, out prefix)
                || prefix > bits)
            {
                error = $"'{Shown(trimmed)}' has a bad prefix: after the / comes a number from 0 to {bits}.";
                return false;
            }
        }

        var canonical = new IPNetwork(Mask(address, prefix), prefix);
        if (!canonical.BaseAddress.Equals(address))
        {
            error = $"'{Shown(trimmed)}' has host bits set past the /{prefix}: did you mean {Format(canonical)}?";
            return false;
        }

        network = canonical;
        error = string.Empty;
        return true;
    }

    /// <summary>One address, IPv4 as four dotted decimals or IPv6, without a prefix or a zone.</summary>
    public static bool TryParseAddress(string? text, out IPAddress address)
    {
        address = IPAddress.None;
        if (string.IsNullOrEmpty(text) || text.Length > MaxLength)
        {
            return false;
        }

        if (text.Contains(':', StringComparison.Ordinal))
        {
            if (!Ipv6Characters().IsMatch(text) || !IPAddress.TryParse(text, out var v6) || v6.AddressFamily != AddressFamily.InterNetworkV6)
            {
                return false;
            }

            address = v6;
            return true;
        }

        if (!DottedQuad().IsMatch(text)
            || text.Split('.').Any(part => part.Length > 1 && part[0] == '0')
            || !IPAddress.TryParse(text, out var v4))
        {
            return false;
        }

        address = v4;
        return true;
    }

    /// <summary>"203.0.113.7" for a host, "10.0.0.0/8" for a network.</summary>
    public static string Format(IPNetwork network)
    {
        var bits = network.BaseAddress.AddressFamily == AddressFamily.InterNetworkV6 ? 128 : 32;
        return network.PrefixLength == bits
            ? network.BaseAddress.ToString()
            : $"{network.BaseAddress}/{network.PrefixLength.ToString(CultureInfo.InvariantCulture)}";
    }

    /// <summary>An IPv4-mapped IPv6 address as plain IPv4, without a scope id.</summary>
    public static IPAddress Normalize(IPAddress address)
    {
        ArgumentNullException.ThrowIfNull(address);
        if (address.IsIPv4MappedToIPv6)
        {
            return address.MapToIPv4();
        }

        return address.AddressFamily == AddressFamily.InterNetworkV6 && address.ScopeId != 0
            ? new IPAddress(address.GetAddressBytes())
            : address;
    }

    public static bool IsIpv6(IPNetwork network) => network.BaseAddress.AddressFamily == AddressFamily.InterNetworkV6;

    public static bool IsEverything(IPNetwork network) => network.PrefixLength == 0;

    private static IPAddress Mask(IPAddress address, int prefix)
    {
        var bytes = address.GetAddressBytes();
        for (var i = 0; i < bytes.Length; i++)
        {
            var keep = Math.Clamp(prefix - (i * 8), 0, 8);
            bytes[i] &= (byte)(0xFF << (8 - keep));
        }

        return new IPAddress(bytes);
    }

    /// <summary>What a refusal repeats of the input: printable and short, whatever was sent.</summary>
    private static string Shown(string text)
    {
        var printable = new string([.. text.Where(character => !char.IsControl(character))]);
        return printable.Length <= MaxLength ? printable : printable[..MaxLength] + "…";
    }

    [GeneratedRegex(@"^(0|[1-9][0-9]{0,2})$", RegexOptions.CultureInvariant)]
    private static partial Regex Prefix();

    [GeneratedRegex(@"^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$", RegexOptions.CultureInvariant)]
    private static partial Regex DottedQuad();

    [GeneratedRegex(@"^[0-9A-Fa-f:.]+$", RegexOptions.CultureInvariant)]
    private static partial Regex Ipv6Characters();

    [GeneratedRegex(@"^[0-9A-Fa-f:./]+$", RegexOptions.CultureInvariant)]
    private static partial Regex NetworkCharacters();
}
