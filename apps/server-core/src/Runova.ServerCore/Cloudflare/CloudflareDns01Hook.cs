using System.Collections.Concurrent;
using Runova.ServerCore.Certificates.Acme;

namespace Runova.ServerCore.Cloudflare;

/// <param name="PropagationDelay">
/// How long to wait after Cloudflare has the record before the CA is told to look. Cloudflare
/// serves a new record from its edge within seconds; the wait covers the slow end of that.
/// </param>
internal sealed record CloudflareDns01Options(TimeSpan PropagationDelay)
{
    public static CloudflareDns01Options Default { get; } = new(TimeSpan.FromSeconds(20));
}

/// <summary>
/// DNS-01 through Cloudflare (E14 T7, the hook E11 left for it): the challenge's TXT record is
/// added with the zone's own DNS token, kept for as long as the CA validates, then removed.
/// A name without a token stops issuance with what to do about it.
/// </summary>
internal sealed partial class CloudflareDns01Hook(
    DnsCredentials credentials,
    ICloudflareDnsApi api,
    CloudflareDns01Options options,
    TimeProvider time,
    ILogger<CloudflareDns01Hook> logger) : IDns01ChallengeHook, IDns01Coverage
{
    private readonly ConcurrentDictionary<(string Name, string Value), (string Zone, string ZoneId, string RecordId)> _published = new();

    public async Task<bool> CoversAsync(string domain, CancellationToken cancellationToken) =>
        await credentials.ForDomainAsync(domain, cancellationToken) is not null;

    public async Task PublishAsync(string domain, string recordName, string value, CancellationToken cancellationToken)
    {
        var zone = await credentials.ForDomainAsync(domain, cancellationToken)
            ?? throw new AcmeException(
                $"{domain} has no Cloudflare DNS token on this server, so DNS-01 cannot answer for it. On the Cloudflare page, send this server a DNS token for its zone, then issue again.");
        string recordId;
        try
        {
            recordId = await api.CreateTxtAsync(zone.ZoneId, zone.Token, recordName, value, cancellationToken);
        }
        catch (CloudflareApiException refused)
        {
            await credentials.RecordUseAsync(zone.Zone, refused.Message);
            throw new AcmeException(
                $"Cloudflare would not add the DNS-01 record for {domain}: {refused.Message} The zone's DNS token may have been deleted or lack Zone > DNS > Edit; send a new one from the Cloudflare page.");
        }

        _published[(recordName, value)] = (zone.Zone, zone.ZoneId, recordId);
        await credentials.RecordUseAsync(zone.Zone, null);
        LogPublished(logger, recordName, zone.Zone);
        await Task.Delay(options.PropagationDelay, time, cancellationToken);
    }

    public async Task RemoveAsync(string domain, string recordName, string value, CancellationToken cancellationToken)
    {
        if (_published.TryRemove((recordName, value), out var known))
        {
            var zone = await credentials.ForDomainAsync(domain, cancellationToken);
            if (zone is not null)
            {
                await api.DeleteAsync(known.ZoneId, zone.Token, known.RecordId, cancellationToken);
            }

            return;
        }

        // A core restarted mid-validation forgot the id; find the record by its name and value.
        if (await credentials.ForDomainAsync(domain, cancellationToken) is { } found)
        {
            foreach (var record in await api.FindTxtAsync(found.ZoneId, found.Token, recordName, cancellationToken))
            {
                if (record.Content == value)
                {
                    await api.DeleteAsync(found.ZoneId, found.Token, record.Id, cancellationToken);
                }
            }
        }
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Published the DNS-01 record {RecordName} in the Cloudflare zone {Zone}.")]
    private static partial void LogPublished(ILogger logger, string recordName, string zone);
}
