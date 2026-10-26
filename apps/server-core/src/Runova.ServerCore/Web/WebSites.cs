using Microsoft.EntityFrameworkCore;
using Runova.ServerCore.Certificates;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Nginx;
using Runova.ServerCore.Updates;

namespace Runova.ServerCore.Web;

/// <summary>
/// Websites and stream proxies: saved in the database, checked on save, and put live together by
/// <see cref="ApplyAsync"/>. The database is the source of truth; every apply renders nginx's files
/// from it, certificates included, so what nginx runs can always be rebuilt.
/// </summary>
internal sealed partial class WebSites(
    IDbContextFactory<CoreDbContext> contexts,
    NginxControl control,
    NginxApplier applier,
    NginxSeLinux seLinux,
    UpstreamPolicy upstreams,
    CertificateKeys keys,
    OsInfo os,
    TimeProvider time,
    ILogger<WebSites> logger) : INginxMoveData
{
    /// <summary>How long one apply may take in all; undoing a failed one has its own budget.</summary>
    public static readonly TimeSpan ApplyTimeout = TimeSpan.FromMinutes(3);

    public const int MaxSites = 500;
    public const int MaxStreams = 200;

    private long Now => time.GetUtcNow().ToUnixTimeMilliseconds();

    public async Task<(NginxInspection Inspection, NginxLayout Layout)> InspectAsync(CancellationToken cancellationToken)
    {
        var first = await control.InspectAsync(NginxControl.LayoutFor(os.Family, NginxInspection.Missing(false, true)), cancellationToken);
        var layout = NginxControl.LayoutFor(os.Family, first);
        return (first, layout);
    }

    public async Task<NginxStatus> StatusAsync(CancellationToken cancellationToken)
    {
        var (inspection, _) = await InspectAsync(cancellationToken);
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var last = await db.NginxReleases.AsNoTracking().OrderByDescending(r => r.Id).FirstOrDefaultAsync(cancellationToken);
        var (_, state) = await BuildAsync(db, layout: null, withKeys: false, cancellationToken);
        return new NginxStatus(
            inspection.Installed,
            inspection.Running,
            inspection.Managed,
            inspection.FromNginxOrg,
            inspection.StreamWired,
            last?.Hash != state.Hash,
            inspection.SeLinuxEnabled,
            inspection.Version?.ToString(),
            inspection.CurrentRelease,
            last?.AppliedAt,
            last?.AppliedByName);
    }

    public async Task<SiteInfo[]> ListSitesAsync(CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var sites = await db.Sites.AsNoTracking().OrderBy(s => s.Id).ToListAsync(cancellationToken);
        var certificates = await db.Certificates.AsNoTracking().ToDictionaryAsync(c => c.SiteId, StringComparer.Ordinal, cancellationToken);
        return [.. sites.Select(site => ToInfo(site, certificates.GetValueOrDefault(site.Id)))];
    }

    public async Task<SiteInfo?> GetSiteAsync(string siteId, CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var site = await db.Sites.AsNoTracking().FirstOrDefaultAsync(s => s.Id == siteId, cancellationToken);
        return site is null ? null : ToInfo(site, await db.Certificates.AsNoTracking().FirstOrDefaultAsync(c => c.SiteId == siteId, cancellationToken));
    }

    /// <summary>Creates or replaces a site's settings (its snippets stay). Nothing is saved when there are problems.</summary>
    public async Task<SiteSaveResult> SaveSiteAsync(SiteSettings settings, CancellationToken cancellationToken)
    {
        if (settings is null || !NginxValidator.IsId(settings.Id))
        {
            return Refused(new NginxProblem($"sites[{NginxNames.Show(settings?.Id ?? string.Empty)}].id", "A site id is 1 to 63 lowercase letters, digits and hyphens, not starting or ending with a hyphen."));
        }

        if (WireProblem(settings) is { } wire)
        {
            return Refused(wire);
        }

        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var existing = await db.Sites.FirstOrDefaultAsync(s => s.Id == settings.Id, cancellationToken);
        if (existing is null && await db.Sites.CountAsync(cancellationToken) >= MaxSites)
        {
            return Refused(new NginxProblem($"sites[{settings.Id}]", $"A server can have at most {MaxSites} sites."));
        }

        var problems = new List<NginxProblem>();
        var stored = existing?.BasicAuthHashes is { } json ? SiteMapping.Deserialize<Dictionary<string, string>>(json) : [];
        var hashes = SiteMapping.HashPasswords(settings, stored, problems);
        if (problems.Count > 0)
        {
            return new SiteSaveResult([.. problems.Select(SiteMapping.ToInfo)]);
        }

        var normalized = SiteMapping.Normalize(settings);
        var candidate = SiteMapping.ToModel(normalized, hashes, existing?.ServerSnippet, existing?.LocationSnippet, certificate: null);
        problems.AddRange(await ValidateSiteAsync(db, candidate, cancellationToken));
        if (problems.Count > 0)
        {
            return new SiteSaveResult([.. problems.Select(SiteMapping.ToInfo)]);
        }

        var now = Now;
        if (existing is null)
        {
            existing = new Site { Id = settings.Id, Settings = string.Empty, CreatedAt = now };
            db.Sites.Add(existing);
        }

        existing.Settings = SiteMapping.Serialize(normalized);
        existing.BasicAuthHashes = hashes.Count > 0 ? SiteMapping.Serialize(hashes) : null;
        existing.UpdatedAt = now;
        await db.SiteDomains.Where(d => d.SiteId == settings.Id).ExecuteDeleteAsync(cancellationToken);
        db.SiteDomains.AddRange(normalized.Domains.Select((domain, position) => new SiteDomain { Domain = domain, SiteId = settings.Id, Position = position }));
        await db.SaveChangesAsync(cancellationToken);
        return new SiteSaveResult([], await GetSiteAsync(settings.Id, cancellationToken));
    }

    /// <summary>The Owner's custom snippets for a site, checked by the allowlist like everything else.</summary>
    public async Task<SiteSaveResult> SetSnippetsAsync(SiteSnippets snippets, CancellationToken cancellationToken)
    {
        if (snippets is null || !NginxValidator.IsId(snippets.SiteId))
        {
            return Refused(new NginxProblem("siteId", "There is no such site."));
        }

        var field = $"sites[{snippets.SiteId}]";
        if ((snippets.ServerSnippet?.Length ?? 0) > SiteMapping.MaxSnippetLength || (snippets.LocationSnippet?.Length ?? 0) > SiteMapping.MaxSnippetLength)
        {
            return Refused(new NginxProblem(field, $"A snippet is at most {SiteMapping.MaxSnippetLength} characters."));
        }

        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var site = await db.Sites.FirstOrDefaultAsync(s => s.Id == snippets.SiteId, cancellationToken);
        if (site is null)
        {
            return Refused(new NginxProblem(field, "There is no such site."));
        }

        var server = Blank(snippets.ServerSnippet) ? null : NginxSnippet.Normalize(snippets.ServerSnippet!);
        var location = Blank(snippets.LocationSnippet) ? null : NginxSnippet.Normalize(snippets.LocationSnippet!);
        var candidate = SiteMapping.ToModel(site, certificate: null) with { ServerSnippet = server, LocationSnippet = location };
        var problems = await ValidateSiteAsync(db, candidate, cancellationToken);
        if (problems.Count > 0)
        {
            return new SiteSaveResult([.. problems.Select(SiteMapping.ToInfo)]);
        }

        site.ServerSnippet = server;
        site.LocationSnippet = location;
        site.UpdatedAt = Now;
        await db.SaveChangesAsync(cancellationToken);
        return new SiteSaveResult([], await GetSiteAsync(site.Id, cancellationToken));
    }

    /// <summary>Removes the site (and its certificate) from the database; the next apply takes it out of nginx.</summary>
    public async Task<bool> DeleteSiteAsync(string siteId, CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        return await db.Sites.Where(s => s.Id == siteId).ExecuteDeleteAsync(cancellationToken) > 0;
    }

    public async Task<StreamProxyInfo[]> ListStreamsAsync(CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var rows = await db.StreamProxies.AsNoTracking().OrderBy(p => p.Id).ToListAsync(cancellationToken);
        return [.. rows.Select(ToInfo)];
    }

    public async Task<StreamProxySaveResult> SaveStreamAsync(StreamProxySettings settings, CancellationToken cancellationToken)
    {
        if (settings is null || !NginxValidator.IsId(settings.Id))
        {
            return new StreamProxySaveResult([new NginxProblemInfo("id", "A stream proxy id is 1 to 63 lowercase letters, digits and hyphens.")]);
        }

        var field = $"streams[{settings.Id}]";
        if (!Enum.IsDefined(settings.Protocol) || settings.Upstream is null || !Enum.IsDefined(settings.Upstream.Kind))
        {
            return new StreamProxySaveResult([new NginxProblemInfo(field, "A stream proxy needs TCP or UDP and an upstream.")]);
        }

        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var existing = await db.StreamProxies.FirstOrDefaultAsync(p => p.Id == settings.Id, cancellationToken);
        if (existing is null && await db.StreamProxies.CountAsync(cancellationToken) >= MaxStreams)
        {
            return new StreamProxySaveResult([new NginxProblemInfo(field, $"A server can have at most {MaxStreams} stream proxies.")]);
        }

        var others = (await db.StreamProxies.AsNoTracking().Where(p => p.Id != settings.Id).ToListAsync(cancellationToken))
            .Select(row => SiteMapping.ToModel(SiteMapping.Deserialize<StreamProxySettings>(row.Settings)));
        var configuration = new NginxConfiguration([], [.. others, SiteMapping.ToModel(settings)]);
        var problems = NginxValidator.Validate(configuration, NginxControl.LayoutFor(os.Family, NginxInspection.Missing(false, true)), upstreams)
            .Where(problem => problem.Field.StartsWith(field, StringComparison.Ordinal))
            .Select(SiteMapping.ToInfo)
            .ToArray();
        if (problems.Length > 0)
        {
            return new StreamProxySaveResult(problems);
        }

        var now = Now;
        if (existing is null)
        {
            existing = new StreamProxy { Id = settings.Id, Settings = string.Empty, CreatedAt = now };
            db.StreamProxies.Add(existing);
        }

        existing.Settings = SiteMapping.Serialize(settings with { AllowFrom = settings.AllowFrom ?? [] });
        existing.UpdatedAt = now;
        await db.SaveChangesAsync(cancellationToken);
        return new StreamProxySaveResult([], ToInfo(existing));
    }

    public async Task<bool> DeleteStreamAsync(string id, CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        return await db.StreamProxies.Where(p => p.Id == id).ExecuteDeleteAsync(cancellationToken) > 0;
    }

    /// <summary>
    /// Renders everything saved and puts it live, or leaves nginx as it was and says why. It runs
    /// on its own time limit, not the caller's: a client that goes away mid-apply must not stop a
    /// rollback halfway.
    /// </summary>
    public async Task<NginxApplyResult> ApplyAsync(Requester? who, CancellationToken cancellationToken)
    {
        using var timeout = new CancellationTokenSource(ApplyTimeout, time);
        var token = timeout.Token;
        using var lease = await applier.LockAsync(cancellationToken);
        var (inspection, layout) = await InspectAsync(token);
        await using var db = await contexts.CreateDbContextAsync(token);
        var (plan, state) = await BuildAsync(db, layout, withKeys: true, token);
        var outcome = await applier.ApplyAsync(plan with { State = state }, inspection, layout, token);
        if (outcome.Applied)
        {
            await RecordAsync(db, outcome.Release!.Value, state, who, token);
            await applier.CompleteAsync(plan, layout, outcome.Release.Value, token);
        }

        return new NginxApplyResult(outcome.Applied, [.. outcome.Problems.Select(SiteMapping.ToInfo)], [.. outcome.Warnings], outcome.Release, outcome.Error);
    }

    /// <summary>
    /// Moves nginx set up before the rename to the new names (NginxNameMove), under the apply lock
    /// so no apply runs meanwhile.
    /// </summary>
    public async Task<NameMoveStatus> MoveToNewNamesAsync(string journalPath, ILogger<NginxNameMove> moveLogger, CancellationToken cancellationToken)
    {
        using var lease = await applier.LockAsync(cancellationToken);
        var move = new NginxNameMove(control, applier, seLinux, this, os.Family, journalPath, moveLogger);
        return await move.RunAsync(cancellationToken);
    }

    async Task<IReadOnlyList<SiteSnippetRow>> INginxMoveData.SnippetsAsync(CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        return await db.Sites.AsNoTracking()
            .Select(site => new SiteSnippetRow(site.Id, site.ServerSnippet, site.LocationSnippet))
            .ToListAsync(cancellationToken);
    }

    async Task INginxMoveData.SetSnippetsAsync(IReadOnlyList<SiteSnippetRow> snippets, CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        foreach (var row in snippets)
        {
            await db.Sites.Where(site => site.Id == row.SiteId).ExecuteUpdateAsync(
                update => update.SetProperty(site => site.ServerSnippet, row.ServerSnippet).SetProperty(site => site.LocationSnippet, row.LocationSnippet),
                cancellationToken);
        }
    }

    async Task<(NginxApplyPlan Plan, NginxAppliedState State)> INginxMoveData.PlanAsync(NginxLayout layout, CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        return await BuildAsync(db, layout, withKeys: true, cancellationToken);
    }

    async Task INginxMoveData.RecordAsync(int release, NginxAppliedState state, CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        await RecordAsync(db, release, state, who: null, cancellationToken);
    }

    /// <summary>On start: finishes or undoes an apply a previous core left halfway.</summary>
    public async Task RecoverAsync(CancellationToken cancellationToken)
    {
        using var lease = await applier.LockAsync(cancellationToken);
        var (inspection, layout) = await InspectAsync(cancellationToken);
        if (!inspection.Installed)
        {
            return;
        }

        var marker = await applier.RecoverAsync(layout, inspection, cancellationToken);
        if (marker is { Phase: NginxApplyMarker.Reloaded })
        {
            await using var db = await contexts.CreateDbContextAsync(cancellationToken);
            await RecordAsync(db, marker.Release, marker.State, who: null, cancellationToken);
            await control.Machine.DeleteAsync(layout.ApplyMarker, cancellationToken);
        }
    }

    /// <summary>
    /// The whole configuration from the database, with the state an apply would record. Keys are
    /// only unsealed for an apply, never for a status read.
    /// </summary>
    private async Task<(NginxApplyPlan Plan, NginxAppliedState State)> BuildAsync(CoreDbContext db, NginxLayout? layout, bool withKeys, CancellationToken cancellationToken)
    {
        layout ??= NginxControl.LayoutFor(os.Family, NginxInspection.Missing(false, true));
        var sites = await db.Sites.AsNoTracking().OrderBy(s => s.Id).ToListAsync(cancellationToken);
        var streams = await db.StreamProxies.AsNoTracking().OrderBy(p => p.Id).ToListAsync(cancellationToken);
        var certificates = await db.Certificates.AsNoTracking().Where(c => c.RevokedAt == null).ToDictionaryAsync(c => c.SiteId, StringComparer.Ordinal, cancellationToken);

        var models = new List<NginxSite>();
        var files = new List<NginxCertificateFiles>();
        var siteStates = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var site in sites)
        {
            NginxCertificate? certificate = null;
            if (certificates.TryGetValue(site.Id, out var row))
            {
                certificate = new NginxCertificate(layout.CertificateFile(site.Id), layout.KeyFile(site.Id));
                if (withKeys)
                {
                    files.Add(new NginxCertificateFiles(site.Id, row.ChainPem, keys.CertificateKeyPem(row.ProtectedKey)));
                }
            }

            models.Add(SiteMapping.ToModel(site, certificate));
            siteStates[site.Id] = SiteFingerprint(site, row);
        }

        var streamStates = streams.ToDictionary(p => p.Id, p => SiteMapping.Fingerprint(p.Settings), StringComparer.Ordinal);
        var originLock = Cloudflare.OriginLockRows.ToModel(await db.OriginLock.AsNoTracking().FirstOrDefaultAsync(setting => setting.Id == OriginLockSetting.SingletonId, cancellationToken));
        var configuration = new NginxConfiguration(models, [.. streams.Select(p => SiteMapping.ToModel(SiteMapping.Deserialize<StreamProxySettings>(p.Settings)))], originLock);
        var hash = SiteMapping.Fingerprint([
            .. siteStates.Select(e => $"s:{e.Key}={e.Value}"),
            .. streamStates.Select(e => $"t:{e.Key}={e.Value}"),
            .. originLock is null ? [] : new[] { $"o:{originLock.AuthenticatedOriginPulls}:{string.Join(',', originLock.CloudflareNetworks)}" }]);
        var state = new NginxAppliedState(hash, siteStates, streamStates);
        return (new NginxApplyPlan(configuration, files, state), state);
    }

    private async Task RecordAsync(CoreDbContext db, int release, NginxAppliedState state, Requester? who, CancellationToken cancellationToken)
    {
        db.NginxReleases.Add(new NginxReleaseRecord
        {
            Release = release,
            Hash = state.Hash,
            AppliedAt = Now,
            AppliedBy = who?.UserId,
            AppliedByName = who?.UserName,
        });
        await db.SaveChangesAsync(cancellationToken);
        foreach (var (id, fingerprint) in state.Sites)
        {
            await db.Sites.Where(s => s.Id == id).ExecuteUpdateAsync(update => update.SetProperty(s => s.AppliedFingerprint, fingerprint), cancellationToken);
        }

        foreach (var (id, fingerprint) in state.Streams)
        {
            await db.StreamProxies.Where(p => p.Id == id).ExecuteUpdateAsync(update => update.SetProperty(p => p.AppliedFingerprint, fingerprint), cancellationToken);
        }

        LogRecorded(logger, release);
    }

    /// <summary>Problems with this site among all saved ones (another site may hold one of its domains).</summary>
    private async Task<List<NginxProblem>> ValidateSiteAsync(CoreDbContext db, NginxSite candidate, CancellationToken cancellationToken)
    {
        var others = (await db.Sites.AsNoTracking().Where(s => s.Id != candidate.Id).OrderBy(s => s.Id).ToListAsync(cancellationToken))
            .Select(site => SiteMapping.ToModel(site, certificate: null));
        var field = $"sites[{candidate.Id}]";
        return [.. NginxValidator.Validate(new NginxConfiguration([.. others, candidate], []), NginxControl.LayoutFor(os.Family, NginxInspection.Missing(false, true)), upstreams)
            .Where(problem => problem.Field.StartsWith(field, StringComparison.Ordinal))];
    }

    private SiteInfo ToInfo(Site site, SiteCertificate? certificate) => new(
        SiteMapping.Deserialize<SiteSettings>(site.Settings),
        site.AppliedFingerprint == SiteFingerprint(site, certificate is { RevokedAt: null } ? certificate : null),
        site.CreatedAt,
        site.UpdatedAt,
        site.ServerSnippet,
        site.LocationSnippet,
        certificate is null ? null : CertificateViews.ToInfo(certificate, time.GetUtcNow()));

    private static StreamProxyInfo ToInfo(StreamProxy row) =>
        new(SiteMapping.Deserialize<StreamProxySettings>(row.Settings), row.AppliedFingerprint == SiteMapping.Fingerprint(row.Settings), row.UpdatedAt);

    private static string SiteFingerprint(Site site, SiteCertificate? certificate) =>
        SiteMapping.Fingerprint(site.Settings, site.BasicAuthHashes, site.ServerSnippet, site.LocationSnippet, certificate?.ChainPem);

    /// <summary>Wire values no validator sees: enums outside their range, and missing parts.</summary>
    private static NginxProblem? WireProblem(SiteSettings settings)
    {
        var field = $"sites[{settings.Id}]";
        if (settings.Upstream is null || !Enum.IsDefined(settings.Upstream.Kind))
        {
            return new NginxProblem(field + ".upstream", "A site needs an upstream: a service port or a URL.");
        }

        var security = settings.SecurityHeaders ?? new SiteSecurityHeaders();
        return !Enum.IsDefined(security.FrameOptions) || !Enum.IsDefined(security.ReferrerPolicy)
            || (settings.RateLimit is { } rate && !Enum.IsDefined(rate.Per))
            ? new NginxProblem(field, "A setting has a value the core does not know.")
            : null;
    }

    private static SiteSaveResult Refused(NginxProblem problem) => new([SiteMapping.ToInfo(problem)]);

    private static bool Blank(string? text) => string.IsNullOrWhiteSpace(text);

    [LoggerMessage(Level = LogLevel.Information, Message = "Recorded nginx release {Release} as applied.")]
    private static partial void LogRecorded(ILogger logger, int release);
}
