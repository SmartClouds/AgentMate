using System.Net;
using System.Net.Http.Headers;
using System.Net.Sockets;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Runova.ServerCore.Cloudflare;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Hosting;

namespace Runova.ServerCore.Backups;

/// <summary>An A or AAAA record in a Cloudflare zone that has a stored DNS token.</summary>
internal sealed record CloudflareAddressRecord(string Zone, string Id, string Name, string Type, string Content, bool Proxied);

/// <summary>A site's hostname, as the database keeps it.</summary>
internal sealed record SiteHostname(string SiteId, string Domain);

/// <summary>Finding and changing address records with a zone's own token (the E14 DNS tokens may edit DNS).</summary>
internal interface ICloudflareRecords
{
    Task<IReadOnlyList<CloudflareAddressRecord>> FindAsync(string zone, string zoneId, string token, string content, CancellationToken cancellationToken);

    /// <summary>Points the record at a new address; its name, proxying and TTL stay.</summary>
    Task UpdateAsync(string zoneId, string token, CloudflareAddressRecord record, string content, CancellationToken cancellationToken);
}

/// <summary>Cloudflare's dns_records API for A and AAAA records, over the core's Cloudflare client.</summary>
internal sealed class CloudflareRecords(ICloudflareHttp http) : ICloudflareRecords
{
    public async Task<IReadOnlyList<CloudflareAddressRecord>> FindAsync(string zone, string zoneId, string token, string content, CancellationToken cancellationToken)
    {
        var type = IPAddress.TryParse(content, out var address) && address.AddressFamily == AddressFamily.InterNetworkV6 ? "AAAA" : "A";
        var result = await SendAsync(HttpMethod.Get, $"zones/{zoneId}/dns_records?type={type}&content={Uri.EscapeDataString(content)}&per_page=100", token, null, cancellationToken);
        return result is JsonArray records
            ? [.. records.OfType<JsonObject>().Select(record => new CloudflareAddressRecord(
                zone,
                record["id"]?.GetValue<string>() ?? string.Empty,
                record["name"]?.GetValue<string>() ?? string.Empty,
                record["type"]?.GetValue<string>() ?? type,
                record["content"]?.GetValue<string>() ?? string.Empty,
                record["proxied"]?.GetValue<bool>() ?? false)).Where(record => CloudflareApi.IsId(record.Id))]
            : [];
    }

    public Task UpdateAsync(string zoneId, string token, CloudflareAddressRecord record, string content, CancellationToken cancellationToken) =>
        SendAsync(HttpMethod.Patch, $"zones/{zoneId}/dns_records/{record.Id}", token, new JsonObject { ["content"] = content }, cancellationToken);

    private async Task<JsonNode?> SendAsync(HttpMethod method, string path, string token, JsonObject? body, CancellationToken cancellationToken)
    {
        if (!CloudflareApi.IsToken(token))
        {
            throw new CloudflareApiException("That is not a Cloudflare API token.");
        }

        using var request = new HttpRequestMessage(method, new Uri(CloudflareApi.BaseUri, path));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        if (body is not null)
        {
            request.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
        }

        HttpResponseMessage response;
        try
        {
            response = await http.Client.SendAsync(request, cancellationToken);
        }
        catch (HttpRequestException failed)
        {
            throw new CloudflareApiException($"Cloudflare could not be reached: {failed.Message}");
        }

        using (response)
        {
            var json = JsonNode.Parse(await response.Content.ReadAsStringAsync(cancellationToken));
            if (!response.IsSuccessStatusCode || json?["success"]?.GetValue<bool>() != true)
            {
                var message = json?["errors"]?.AsArray().OfType<JsonObject>().Select(e => e["message"]?.GetValue<string>()).FirstOrDefault();
                throw new CloudflareApiException($"Cloudflare refused: {message ?? response.ReasonPhrase}", response.StatusCode);
            }

            return json["result"];
        }
    }
}

/// <summary>What moving to a new address touches, worked out from facts gathered elsewhere (E28).</summary>
internal static class AddressRebindPlanner
{
    /// <summary>Each old address to the first new one of its family. An old one with no counterpart does not move.</summary>
    public static IReadOnlyDictionary<string, string> Map(string[] oldAddresses, string[] newAddresses)
    {
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var old in oldAddresses)
        {
            if (!IPAddress.TryParse(old, out var from))
            {
                continue;
            }

            var to = newAddresses.FirstOrDefault(candidate => IPAddress.TryParse(candidate, out var parsed) && parsed.AddressFamily == from.AddressFamily);
            if (to is not null)
            {
                map[from.ToString()] = to;
            }
        }

        return map;
    }

    /// <summary>The value with its address moved, when it is exactly an old address or that address alone as a network; otherwise null.</summary>
    public static string? Replace(string? value, IReadOnlyDictionary<string, string> map)
    {
        if (string.IsNullOrEmpty(value))
        {
            return null;
        }

        var slash = value.IndexOf('/', StringComparison.Ordinal);
        var address = slash < 0 ? value : value[..slash];
        var prefix = slash < 0 ? null : value[(slash + 1)..];
        if (!IPAddress.TryParse(address, out var parsed) || !map.TryGetValue(parsed.ToString(), out var moved))
        {
            return null;
        }

        var single = parsed.AddressFamily == AddressFamily.InterNetworkV6 ? "128" : "32";
        return prefix is null ? moved : prefix == single ? $"{moved}/{prefix}" : null;
    }

    public static FirewallRuleSpec Rewrite(FirewallRuleSpec rule, IReadOnlyDictionary<string, string> map) =>
        Replace(rule.Source, map) is { } source ? rule with { Source = source } : rule;

    public static IReadOnlyList<AddressChange> Plan(
        IReadOnlyDictionary<string, string> map,
        IEnumerable<SiteHostname> sites,
        IEnumerable<FirewallRuleSpec> firewall,
        IEnumerable<CloudflareAddressRecord> records,
        IEnumerable<string> stackFiles)
    {
        var changes = new List<AddressChange>();
        foreach (var site in sites)
        {
            if (Replace(site.Domain, map) is { } moved)
            {
                changes.Add(new AddressChange("Website", site.Domain, site.Domain, moved, true, null));
            }
        }

        foreach (var rule in firewall)
        {
            if (Replace(rule.Source, map) is { } moved)
            {
                changes.Add(new AddressChange("Firewall rule", Describe(rule), rule.Source!, moved, true, "Applied with the backup's firewall rules."));
            }
        }

        foreach (var record in records)
        {
            if (Replace(record.Content, map) is { } moved)
            {
                changes.Add(new AddressChange("Cloudflare DNS", record.Name, record.Content, moved, true, record.Proxied ? "Proxied through Cloudflare." : null));
            }
        }

        foreach (var file in stackFiles)
        {
            changes.Add(new AddressChange("Stack file", file, string.Join(", ", map.Keys), string.Join(", ", map.Values), false, "This file names the old address. Check it and edit the stack."));
        }

        return changes;
    }

    /// <summary>Site hostnames on DNS the core cannot change: not an address, and in no zone with a stored token.</summary>
    public static IReadOnlyList<string> ManualDns(IEnumerable<string> hostnames, IEnumerable<string> zones)
    {
        var known = zones.Select(zone => zone.ToLowerInvariant()).ToList();
        return [.. hostnames
            .Select(name => name.ToLowerInvariant())
            .Where(name => !IPAddress.TryParse(name, out _) && !known.Any(zone => name == zone || name.EndsWith("." + zone, StringComparison.Ordinal)))
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)];
    }

    private static string Describe(FirewallRuleSpec rule) =>
        $"{rule.Action} {rule.Protocol}{(rule.Port is { } port ? " " + port.ToString(System.Globalization.CultureInfo.InvariantCulture) : string.Empty)}";
}

/// <summary>
/// Moves a restored server's settings to its new address (E28). Website hostnames that are the
/// old address move in the database (the restore renders nginx afterwards); A and AAAA records
/// pointing at the old address in every zone with a stored DNS token move in Cloudflare. Firewall
/// rules move as the app applies them. Stack files that name the old address are reported, not
/// edited: a wrong guess in someone's compose file is worse than a line in a summary.
/// </summary>
internal sealed class AddressRebinder(IDbContextFactory<CoreDbContext> contexts, DnsCredentials credentials, ICloudflareRecords cloudflare, CoreDirectories directories)
    : IAddressRebinder
{
    private const long MaxScannedFileBytes = 1024 * 1024;

    public async Task<IReadOnlyList<AddressChange>> PlanAsync(string[] oldAddresses, string[] newAddresses, CancellationToken cancellationToken)
    {
        var map = AddressRebindPlanner.Map(oldAddresses, newAddresses);
        var (sites, records, files, _) = await GatherAsync(map, cancellationToken);
        return AddressRebindPlanner.Plan(map, sites, [], records.Select(r => r.Record), files);
    }

    public async Task<AddressMove> ApplyAsync(string[] oldAddresses, string[] newAddresses, CancellationToken cancellationToken)
    {
        var map = AddressRebindPlanner.Map(oldAddresses, newAddresses);
        var (sites, records, files, zones) = await GatherAsync(map, cancellationToken);
        var plan = AddressRebindPlanner.Plan(map, sites, [], records.Select(r => r.Record), files);

        await using (var db = await contexts.CreateDbContextAsync(cancellationToken))
        {
            foreach (var change in plan.Where(c => c.Area == "Website"))
            {
                await db.SiteDomains.Where(d => d.Domain == change.From).ExecuteUpdateAsync(set => set.SetProperty(d => d.Domain, change.To), cancellationToken);
            }
        }

        foreach (var (record, zoneId, token) in records)
        {
            if (AddressRebindPlanner.Replace(record.Content, map) is { } moved)
            {
                await cloudflare.UpdateAsync(zoneId, token, record, moved, cancellationToken);
            }
        }

        return new AddressMove(plan, AddressRebindPlanner.ManualDns(sites.Select(s => s.Domain), zones));
    }

    private async Task<(List<SiteHostname> Sites, List<(CloudflareAddressRecord Record, string ZoneId, string Token)> Records, List<string> Files, List<string> Zones)> GatherAsync(
        IReadOnlyDictionary<string, string> map,
        CancellationToken cancellationToken)
    {
        List<SiteHostname> sites;
        await using (var db = await contexts.CreateDbContextAsync(cancellationToken))
        {
            sites = await db.SiteDomains.AsNoTracking().OrderBy(d => d.SiteId).ThenBy(d => d.Position).Select(d => new SiteHostname(d.SiteId, d.Domain)).ToListAsync(cancellationToken);
        }

        var records = new List<(CloudflareAddressRecord, string, string)>();
        var zones = new List<string>();
        foreach (var zone in await credentials.ListAsync(cancellationToken))
        {
            zones.Add(zone.Zone);
            if (await credentials.ForDomainAsync(zone.Zone, cancellationToken) is not { } token)
            {
                continue;
            }

            foreach (var old in map.Keys)
            {
                foreach (var record in await cloudflare.FindAsync(zone.Zone, token.ZoneId, token.Token, old, cancellationToken))
                {
                    records.Add((record, token.ZoneId, token.Token));
                }
            }
        }

        return (sites, records, StackFilesNaming(map.Keys), zones);
    }

    private List<string> StackFilesNaming(IEnumerable<string> addresses)
    {
        var root = Path.Combine(directories.Data, "stacks");
        if (!Directory.Exists(root))
        {
            return [];
        }

        var wanted = addresses.ToList();
        var found = new List<string>();
        foreach (var file in Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories))
        {
            var info = new FileInfo(file);
            if (info.Length > MaxScannedFileBytes)
            {
                continue;
            }

            var text = File.ReadAllText(file);
            if (wanted.Any(address => text.Contains(address, StringComparison.OrdinalIgnoreCase)))
            {
                found.Add(Path.GetRelativePath(root, file).Replace('\\', '/'));
            }
        }

        return [.. found.Order(StringComparer.Ordinal)];
    }
}
