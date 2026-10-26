using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Nginx;

namespace Runova.ServerCore.Cloudflare;

/// <summary>
/// Checks the ranges Cloudflare publishes before anything is built from them: each must be a
/// canonical network of its family, public (a private or loopback range would open the server
/// to its own network), and not so wide that "Cloudflare only" means little. A list that fails
/// any check is refused whole, so a bad answer never half-replaces a good one.
/// </summary>
internal static class CloudflareRangeList
{
    public const int MaxRanges = 100;

    /// <summary>Narrowest prefix accepted; Cloudflare's widest are /12 (IPv4) and /29 (IPv6).</summary>
    public const int MinIpv4Prefix = 8;

    public const int MinIpv6Prefix = 16;

    public static CloudflareRanges Parse(IReadOnlyList<string> ipv4, IReadOnlyList<string> ipv6, long fetchedAtUnixMs)
    {
        ArgumentNullException.ThrowIfNull(ipv4);
        ArgumentNullException.ThrowIfNull(ipv6);
        if (ipv4.Count == 0 || ipv6.Count == 0)
        {
            throw new CloudflareApiException("Cloudflare's list of addresses came back without IPv4 or IPv6 ranges.");
        }

        if (ipv4.Count + ipv6.Count > MaxRanges)
        {
            throw new CloudflareApiException($"Cloudflare's list of addresses has more than {MaxRanges} ranges, which is not what it publishes.");
        }

        return new CloudflareRanges(Check(ipv4, AddressFamily.InterNetwork), Check(ipv6, AddressFamily.InterNetworkV6), fetchedAtUnixMs);
    }

    public static IEnumerable<string> All(CloudflareRanges ranges)
    {
        ArgumentNullException.ThrowIfNull(ranges);
        return ranges.Ipv4.Concat(ranges.Ipv6);
    }

    private static string[] Check(IReadOnlyList<string> ranges, AddressFamily family)
    {
        var checkedRanges = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var range in ranges)
        {
            if (string.IsNullOrEmpty(range) || !range.Contains('/', StringComparison.Ordinal)
                || !NginxAddresses.TryParseNetwork(range, out var canonical, out _))
            {
                throw new CloudflareApiException($"Cloudflare's list of addresses has an entry that is not a network: {Shown(range)}.");
            }

            var network = IPNetwork.Parse(canonical);
            if (network.BaseAddress.AddressFamily != family)
            {
                throw new CloudflareApiException($"Cloudflare's list of addresses has {canonical} in the wrong family.");
            }

            var minPrefix = family == AddressFamily.InterNetwork ? MinIpv4Prefix : MinIpv6Prefix;
            if (network.PrefixLength < minPrefix)
            {
                throw new CloudflareApiException($"Cloudflare's list of addresses has {canonical}, which is far wider than any network Cloudflare runs.");
            }

            if (NginxAddresses.Refusal(network.BaseAddress) is not null || IsPrivate(network.BaseAddress))
            {
                throw new CloudflareApiException($"Cloudflare's list of addresses has {canonical}, which is not a public network.");
            }

            checkedRanges.Add(canonical);
        }

        return [.. checkedRanges];
    }

    private static bool IsPrivate(IPAddress address)
    {
        if (address.AddressFamily == AddressFamily.InterNetworkV6)
        {
            return address.IsIPv6LinkLocal || address.IsIPv6SiteLocal || address.IsIPv6UniqueLocal || IPAddress.IsLoopback(address);
        }

        var bytes = address.GetAddressBytes();
        return bytes[0] switch
        {
            10 or 127 or 0 => true,
            172 => bytes[1] is >= 16 and <= 31,
            192 => bytes[1] == 168,
            100 => bytes[1] is >= 64 and <= 127,
            169 => bytes[1] == 254,
            _ => false,
        };
    }

    private static string Shown(string? text) =>
        text is null ? "(nothing)" : new string([.. text.Take(60).Select(c => char.IsControl(c) ? ' ' : c)]);
}

/// <summary>The origin lock's row in the database, read as the parts the rest of the core uses.</summary>
internal static class OriginLockRows
{
    public static CloudflareRanges? Ranges(OriginLockSetting? row) =>
        row?.RangesFetchedAt is { } fetched
            ? new CloudflareRanges(
                JsonSerializer.Deserialize<string[]>(row.Ipv4, CoreJson.Options) ?? [],
                JsonSerializer.Deserialize<string[]>(row.Ipv6, CoreJson.Options) ?? [],
                fetched)
            : null;

    public static void SetRanges(OriginLockSetting row, CloudflareRanges ranges)
    {
        ArgumentNullException.ThrowIfNull(row);
        ArgumentNullException.ThrowIfNull(ranges);
        row.Ipv4 = JsonSerializer.Serialize(ranges.Ipv4, CoreJson.Options);
        row.Ipv6 = JsonSerializer.Serialize(ranges.Ipv6, CoreJson.Options);
        row.RangesFetchedAt = ranges.FetchedAtUnixMs;
    }

    /// <summary>What nginx renders: only while the lock is on and ranges are known.</summary>
    public static NginxOriginLock? ToModel(OriginLockSetting? row) =>
        row is { Enabled: true } && Ranges(row) is { } ranges
            ? new NginxOriginLock([.. CloudflareRangeList.All(ranges)], row.AuthenticatedOriginPulls)
            : null;
}
