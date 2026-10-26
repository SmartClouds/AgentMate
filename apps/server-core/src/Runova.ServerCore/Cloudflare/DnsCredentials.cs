using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Runova.ServerCore.Compatibility;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Nginx;
using Runova.ServerCore.Updates;

namespace Runova.ServerCore.Cloudflare;

/// <summary>A zone's token, unsealed for one use.</summary>
internal sealed record DnsZoneToken(string Zone, string ZoneId, string Token);

/// <summary>
/// The zone-scoped DNS tokens a person sent this server for DNS-01 (E14 T7). Each is checked with
/// Cloudflare before it is kept, sealed with Data Protection under its own purpose, and never
/// returned: the list says which zones have one, and when it was last used.
/// </summary>
internal sealed class DnsCredentials(
    IDbContextFactory<CoreDbContext> contexts,
    IDataProtectionProvider protection,
    ICloudflareDnsApi api,
    TimeProvider time)
{
    public const string Provider = "cloudflare";

    private const int MaxErrorLength = 1000;

    private readonly IDataProtector _tokens = protection.CreateProtector(FrozenIdentifiers.CloudflareDnsTokenPurpose);

    private long Now => time.GetUtcNow().ToUnixTimeMilliseconds();

    public async Task<DnsCredentialInfo[]> ListAsync(CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var rows = await db.DnsCredentials.AsNoTracking().OrderBy(c => c.Zone).ToListAsync(cancellationToken);
        return [.. rows.Select(ToInfo)];
    }

    public async Task<DnsCredentialSaveResult> SaveAsync(DnsCredentialRequest? request, Requester who, CancellationToken cancellationToken)
    {
        var problems = new List<string>();
        var zone = request?.Zone?.Trim().ToLowerInvariant() ?? string.Empty;
        if (request is null || NginxNames.DomainProblem(zone) is not null || zone.StartsWith("*.", StringComparison.Ordinal) || zone.Length > 253)
        {
            problems.Add("The zone is not a domain name like example.com.");
        }

        if (!CloudflareApi.IsId(request?.ZoneId))
        {
            problems.Add("The zone id is not a Cloudflare id (32 hexadecimal characters).");
        }

        if (!CloudflareApi.IsToken(request?.Token))
        {
            problems.Add("That is not a Cloudflare API token.");
        }

        if (request?.TokenId is { } tokenId && !CloudflareApi.IsId(tokenId))
        {
            problems.Add("The token id is not a Cloudflare id.");
        }

        if (problems.Count > 0 || request is null)
        {
            return new DnsCredentialSaveResult([.. problems]);
        }

        string? refused;
        try
        {
            refused = await api.CheckAsync(request.ZoneId, request.Token, cancellationToken);
        }
        catch (CloudflareApiException unreachable)
        {
            refused = $"The token could not be checked: {unreachable.Message}";
        }

        if (refused is not null)
        {
            return new DnsCredentialSaveResult([refused]);
        }

        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var row = await db.DnsCredentials.FirstOrDefaultAsync(c => c.Zone == zone, cancellationToken);
        var now = Now;
        if (row is null)
        {
            row = new DnsCredential { Zone = zone, ZoneId = request.ZoneId, Provider = Provider, ProtectedToken = string.Empty, CreatedAt = now };
            db.DnsCredentials.Add(row);
        }

        row.ZoneId = request.ZoneId;
        row.ProtectedToken = _tokens.Protect(request.Token);
        row.TokenId = request.TokenId;
        row.UpdatedAt = now;
        row.CreatedBy = who.UserName;
        row.LastError = null;
        await db.SaveChangesAsync(cancellationToken);
        return new DnsCredentialSaveResult([], ToInfo(row));
    }

    public async Task<bool> RemoveAsync(string? zone, CancellationToken cancellationToken)
    {
        var name = zone?.Trim().ToLowerInvariant() ?? string.Empty;
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        return await db.DnsCredentials.Where(c => c.Zone == name).ExecuteDeleteAsync(cancellationToken) > 0;
    }

    /// <summary>The token of the zone a name belongs to: the longest stored zone it ends in.</summary>
    public async Task<DnsZoneToken?> ForDomainAsync(string domain, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(domain);
        var name = domain.ToLowerInvariant().TrimEnd('.');
        if (name.StartsWith("*.", StringComparison.Ordinal))
        {
            name = name[2..];
        }

        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var zones = await db.DnsCredentials.AsNoTracking().ToListAsync(cancellationToken);
        var row = zones
            .Where(c => name == c.Zone || name.EndsWith("." + c.Zone, StringComparison.Ordinal))
            .MaxBy(c => c.Zone.Length);
        return row is null ? null : new DnsZoneToken(row.Zone, row.ZoneId, _tokens.Unprotect(row.ProtectedToken));
    }

    /// <summary>Records a use, and what went wrong with it if anything did.</summary>
    public async Task RecordUseAsync(string zone, string? error)
    {
        await using var db = await contexts.CreateDbContextAsync(CancellationToken.None);
        var clipped = error is { Length: > MaxErrorLength } ? error[..(MaxErrorLength - 1)] + "…" : error;
        await db.DnsCredentials.Where(c => c.Zone == zone).ExecuteUpdateAsync(
            update => update.SetProperty(c => c.LastUsedAt, Now).SetProperty(c => c.LastError, clipped),
            CancellationToken.None);
    }

    private static DnsCredentialInfo ToInfo(DnsCredential row) =>
        new(row.Zone, row.ZoneId, row.Provider, row.CreatedAt, row.UpdatedAt, row.TokenId, row.CreatedBy, row.LastUsedAt, row.LastError);
}
