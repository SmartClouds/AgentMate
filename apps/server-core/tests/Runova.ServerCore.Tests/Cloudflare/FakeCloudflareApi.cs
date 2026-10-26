using System.Collections.Concurrent;
using System.Net;
using System.Text;
using Runova.ServerCore.Certificates.Acme;
using Runova.ServerCore.Cloudflare;
using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.Tests.Cloudflare;

/// <summary>Cloudflare's answers as recorded from the live API, for the HTTP client's tests and the fakes.</summary>
internal static class CloudflareRecordings
{
    /// <summary>GET https://api.cloudflare.com/client/v4/ips, recorded 2026-10-02.</summary>
    public const string Ips = """
        {"result":{"ipv4_cidrs":["173.245.48.0/20","103.21.244.0/22","103.22.200.0/22","103.31.4.0/22","141.101.64.0/18","108.162.192.0/18","190.93.240.0/20","188.114.96.0/20","197.234.240.0/22","198.41.128.0/17","162.158.0.0/15","104.16.0.0/13","104.24.0.0/14","172.64.0.0/13","131.0.72.0/22"],"ipv6_cidrs":["2400:cb00::/32","2606:4700::/32","2803:f800::/32","2405:b500::/32","2405:8100::/32","2a06:98c0::/29","2c0f:f248::/32"],"etag":"38f79d050aa027e3be3865e495dcc9bc"},"success":true,"errors":[],"messages":[]}
        """;

    /// <summary>What Cloudflare answers a token without rights on the zone.</summary>
    public const string AuthenticationError = """
        {"success":false,"errors":[{"code":10000,"message":"Authentication error"}],"messages":[],"result":null}
        """;

    public static IReadOnlyList<string> Ipv4 { get; } =
        ["173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22"];

    public static IReadOnlyList<string> Ipv6 { get; } =
        ["2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32"];

    public static CloudflareRanges Ranges => CloudflareRangeList.Parse(Ipv4, Ipv6, 0);
}

/// <summary>
/// Cloudflare for the core's tests: ranges a test can change, and DNS records kept in memory.
/// Tokens starting "denied" are refused, as Cloudflare refuses a token without DNS rights.
/// </summary>
internal sealed class FakeCloudflareApi : ICloudflareRangeSource, ICloudflareDnsApi
{
    private readonly ConcurrentDictionary<string, CloudflareTxtRecord> _records = new(StringComparer.Ordinal);

    public CloudflareRanges Ranges { get; set; } = CloudflareRecordings.Ranges;

    public CloudflareApiException? FetchFailure { get; set; }

    /// <summary>Where a fake CA looks records up: every record made or deleted here is mirrored into it.</summary>
    public InMemoryDns01ChallengeHook? Mirror { get; set; }

    public int Fetches { get; private set; }

    /// <summary>Refuse new records, as Cloudflare does once a token was deleted or lost its rights.</summary>
    public bool RefuseCreates { get; set; }

    public List<(string ZoneId, string Token, string Call)> Calls { get; } = [];

    public IReadOnlyCollection<CloudflareTxtRecord> Records => [.. _records.Values];

    public Task<CloudflareRanges> FetchAsync(CancellationToken cancellationToken)
    {
        Fetches++;
        return FetchFailure is { } failure ? Task.FromException<CloudflareRanges>(failure) : Task.FromResult(Ranges);
    }

    public Task<string?> CheckAsync(string zoneId, string token, CancellationToken cancellationToken)
    {
        Calls.Add((zoneId, token, "check"));
        return Task.FromResult(token.StartsWith("denied", StringComparison.Ordinal)
            ? "This token cannot read the zone's DNS records (Authentication error (code 10000)). It needs Zone > DNS > Edit on this zone."
            : null);
    }

    public Task<string> CreateTxtAsync(string zoneId, string token, string name, string content, CancellationToken cancellationToken)
    {
        Calls.Add((zoneId, token, $"create {name}"));
        if (RefuseCreates || token.StartsWith("denied", StringComparison.Ordinal))
        {
            throw new CloudflareApiException("Authentication error (code 10000)", HttpStatusCode.Forbidden);
        }

        var id = Convert.ToHexStringLower(Encoding.UTF8.GetBytes(Guid.NewGuid().ToString("N")[..16]));
        _records[id] = new CloudflareTxtRecord(id, name, content);
        _ = Mirror?.PublishAsync(name, name, content, cancellationToken);
        return Task.FromResult(id);
    }

    public Task<IReadOnlyList<CloudflareTxtRecord>> FindTxtAsync(string zoneId, string token, string name, CancellationToken cancellationToken)
    {
        Calls.Add((zoneId, token, $"find {name}"));
        return Task.FromResult<IReadOnlyList<CloudflareTxtRecord>>([.. _records.Values.Where(record => record.Name == name)]);
    }

    public Task DeleteAsync(string zoneId, string token, string recordId, CancellationToken cancellationToken)
    {
        Calls.Add((zoneId, token, $"delete {recordId}"));
        if (_records.TryRemove(recordId, out var removed))
        {
            _ = Mirror?.RemoveAsync(removed.Name, removed.Name, removed.Content, cancellationToken);
        }

        return Task.CompletedTask;
    }

    public void AddRecord(string name, string content)
    {
        var id = Convert.ToHexStringLower(Encoding.UTF8.GetBytes(Guid.NewGuid().ToString("N")[..16]));
        _records[id] = new CloudflareTxtRecord(id, name, content);
    }
}
