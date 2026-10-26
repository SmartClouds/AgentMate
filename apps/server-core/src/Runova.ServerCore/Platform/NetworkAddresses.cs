using System.Net;
using System.Net.Sockets;

namespace Runova.ServerCore.Platform;

/// <summary>
/// Which of the server's own addresses the internet can reach, as far as the address itself says.
/// Nothing is looked up outside the server: behind NAT the public address is simply not known.
/// </summary>
internal static class NetworkAddresses
{
    public static bool IsPublic(IPAddress address)
    {
        ArgumentNullException.ThrowIfNull(address);
        if (address.IsIPv4MappedToIPv6)
        {
            address = address.MapToIPv4();
        }

        if (address.AddressFamily == AddressFamily.InterNetwork)
        {
            var bytes = address.GetAddressBytes();
            return bytes switch
            {
                [0, ..] or [10, ..] or [127, ..] => false,
                [100, >= 64 and <= 127, ..] => false,
                [169, 254, ..] => false,
                [172, >= 16 and <= 31, ..] => false,
                [192, 0, 0, _] or [192, 168, ..] => false,
                [198, 18 or 19, ..] => false,
                [>= 224, ..] => false,
                _ => true,
            };
        }

        if (address.AddressFamily != AddressFamily.InterNetworkV6
            || IPAddress.IsLoopback(address)
            || address.Equals(IPAddress.IPv6None)
            || address.IsIPv6LinkLocal
            || address.IsIPv6SiteLocal
            || address.IsIPv6UniqueLocal
            || address.IsIPv6Multicast)
        {
            return false;
        }

        // Global unicast is 2000::/3.
        return (address.GetAddressBytes()[0] & 0xE0) == 0x20;
    }
}
