using System.Collections.Concurrent;
using Runova.ServerCore.Cloudflare;
using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.DevHost.Fakes;

/// <summary>
/// Cloudflare as the DevHost sees it: a short list of real Cloudflare ranges (so the pretend
/// firewall applies in seconds, not a minute), and a DNS API that keeps records in memory and
/// accepts any token that looks like one, except tokens starting "denied", which it refuses as
/// Cloudflare refuses a token without DNS rights. Nothing leaves the machine.
/// </summary>
internal sealed class FakeCloudflare : ICloudflareRangeSource, ICloudflareDnsApi
{
    private readonly ConcurrentDictionary<string, CloudflareTxtRecord> _records = new(StringComparer.Ordinal);

    public Task<CloudflareRanges> FetchAsync(CancellationToken cancellationToken) =>
        Task.FromResult(CloudflareRangeList.Parse(["173.245.48.0/20", "103.21.244.0/22", "104.16.0.0/13"], ["2400:cb00::/32", "2606:4700::/32"], 0));

    public Task<string?> CheckAsync(string zoneId, string token, CancellationToken cancellationToken) =>
        Task.FromResult(token.StartsWith("denied", StringComparison.Ordinal)
            ? "This token cannot read the zone's DNS records (Authentication error (code 10000)). It needs Zone > DNS > Edit on this zone."
            : null);

    public Task<string> CreateTxtAsync(string zoneId, string token, string name, string content, CancellationToken cancellationToken)
    {
        var id = Guid.NewGuid().ToString("N");
        _records[id] = new CloudflareTxtRecord(id, name, content);
        return Task.FromResult(id);
    }

    public Task<IReadOnlyList<CloudflareTxtRecord>> FindTxtAsync(string zoneId, string token, string name, CancellationToken cancellationToken) =>
        Task.FromResult<IReadOnlyList<CloudflareTxtRecord>>([.. _records.Values.Where(record => record.Name == name)]);

    public Task DeleteAsync(string zoneId, string token, string recordId, CancellationToken cancellationToken)
    {
        _records.TryRemove(recordId, out _);
        return Task.CompletedTask;
    }
}
