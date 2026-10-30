using System.Net;
using System.Net.Sockets;

namespace Runova.Website.Api.ApiClients;

/// <summary>A client's allowed addresses: IPv4 and IPv6 addresses and CIDR ranges, none meaning any.</summary>
internal static class IpAllowlist
{
    public static bool IsValidEntry(string entry) => TryParse(entry, out _);

    /// <summary>
    /// Whether the caller may come from <paramref name="address"/>. An IPv4 address seen as IPv6
    /// (<c>::ffff:a.b.c.d</c>) counts as the IPv4 one, and no address at all passes only an empty list.
    /// </summary>
    public static bool Allows(IReadOnlyCollection<string> allowlist, IPAddress? address)
    {
        if (allowlist.Count == 0)
        {
            return true;
        }

        if (address is null)
        {
            return false;
        }

        if (address.IsIPv4MappedToIPv6)
        {
            address = address.MapToIPv4();
        }

        return allowlist.Any(entry => TryParse(entry, out var network) && network.Contains(address));
    }

    // A single address is a network of one.
    private static bool TryParse(string entry, out IPNetwork network)
    {
        if (entry.Contains('/', StringComparison.Ordinal))
        {
            return IPNetwork.TryParse(entry, out network);
        }

        // IPAddress.TryParse also takes shorthand such as "1" for 0.0.0.1, which no one means here.
        if ((entry.Count(c => c == '.') == 3 || entry.Contains(':', StringComparison.Ordinal))
            && IPAddress.TryParse(entry, out var address))
        {
            network = new IPNetwork(address, address.AddressFamily == AddressFamily.InterNetwork ? 32 : 128);
            return true;
        }

        network = default;
        return false;
    }
}
