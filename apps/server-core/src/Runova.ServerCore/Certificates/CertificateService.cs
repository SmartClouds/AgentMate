using System.Globalization;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Runova.ServerCore.Alerts;
using Runova.ServerCore.Certificates.Acme;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Jobs;
using Runova.ServerCore.Nginx;
using Runova.ServerCore.Updates;
using Runova.ServerCore.Web;

namespace Runova.ServerCore.Certificates;

/// <summary>
/// Certificates for sites: issuing and renewing over ACME as jobs (with each step in the log and
/// errors a person can act on), uploading one by hand, and taking one off a site, revoked or not.
/// Every change that touches nginx goes through <see cref="WebSites.ApplyAsync"/>, so a failing
/// configuration never goes live.
/// </summary>
internal sealed partial class CertificateService(
    IDbContextFactory<CoreDbContext> contexts,
    WebSites sites,
    ICertificateAuthorities issuers,
    AcmeDirectoryChoice directories,
    JobEngine jobs,
    AlertCenter alerts,
    IUpstreamResolver resolver,
    CertificateKeys keys,
    TimeProvider time,
    ILogger<CertificateService> logger)
{
    /// <summary>The first wait after a failed renewal; it doubles with each failure.</summary>
    public static readonly TimeSpan FirstBackoff = TimeSpan.FromHours(1);

    public static readonly TimeSpan MaxBackoff = TimeSpan.FromDays(1);

    /// <summary>A renewal failure this close to expiry is critical rather than a warning.</summary>
    public static readonly TimeSpan CriticalWithin = TimeSpan.FromDays(7);

    public static string LockFor(string siteId) => "certificate:" + siteId;

    private long Now => time.GetUtcNow().ToUnixTimeMilliseconds();

    public async Task<CertificateInfo[]> ListAsync(CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var rows = await db.Certificates.AsNoTracking().OrderBy(c => c.SiteId).ToListAsync(cancellationToken);
        return [.. rows.Select(row => CertificateViews.ToInfo(row, time.GetUtcNow()))];
    }

    /// <summary>Starts the issuance job. Refused at once when the site does not exist.</summary>
    public async Task<JobInfo> StartIssueAsync(CertificateIssueRequest request, Requester who, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        var site = await RequireSiteAsync(request.SiteId, cancellationToken);
        if (request.ContactEmail is { } email)
        {
            AcmeClient.ToMailto(email);
        }

        return await jobs.StartAsync(
            new JobRequest(JobKind.CertificateIssue, $"Issue a certificate for {site.Settings.Domains.FirstOrDefault() ?? site.Settings.Id}", [LockFor(site.Settings.Id)], site.Settings.Id, who.UserId, who.UserName),
            (job, token) => IssueAsync(request, who, job, token),
            cancellationToken);
    }

    /// <summary>Starts a renewal job for a site's Let's Encrypt certificate.</summary>
    public async Task<JobInfo> StartRenewAsync(string siteId, Requester? who, CancellationToken cancellationToken)
    {
        await using (var db = await contexts.CreateDbContextAsync(cancellationToken))
        {
            var row = await db.Certificates.AsNoTracking().FirstOrDefaultAsync(c => c.SiteId == siteId, cancellationToken);
            if (row is null || row.Source != CertificateViews.AcmeSource || row.RevokedAt is not null)
            {
                throw new ArgumentException("This site has no Let's Encrypt certificate to renew.", nameof(siteId));
            }
        }

        return await jobs.StartAsync(
            new JobRequest(JobKind.CertificateRenew, $"Renew the certificate of {siteId}", [LockFor(siteId)], siteId, who?.UserId, who?.UserName ?? "the renewal service"),
            (job, token) => RenewAsync(siteId, who, job, token),
            cancellationToken);
    }

    /// <param name="source">Uploaded by hand, or (E14) a Cloudflare Origin CA certificate for a key made here.</param>
    public async Task<CertificateUploadResult> UploadAsync(CertificateUploadRequest request, Requester who, CancellationToken cancellationToken, string source = CertificateViews.UploadedSource)
    {
        ArgumentNullException.ThrowIfNull(request);
        var site = await RequireSiteAsync(request.SiteId, cancellationToken);
        var problems = new List<string>();
        var checkedUpload = CertificateUpload.Check(request.CertificatePem, request.PrivateKeyPem, site.Settings.Domains, time.GetUtcNow(), problems);
        if (problems.Count > 0)
        {
            return new CertificateUploadResult([.. problems]);
        }

        await using (var db = await contexts.CreateDbContextAsync(cancellationToken))
        {
            var row = await db.Certificates.FirstOrDefaultAsync(c => c.SiteId == site.Settings.Id, cancellationToken);
            if (row is null)
            {
                row = new SiteCertificate { SiteId = site.Settings.Id, Source = string.Empty, Domains = string.Empty, KeyType = string.Empty, ChainPem = string.Empty, ProtectedKey = string.Empty, Issuer = string.Empty };
                db.Certificates.Add(row);
            }

            row.Source = source;
            row.DirectoryUrl = null;
            row.CertificateId = null;
            row.Domains = JsonSerializer.Serialize(checkedUpload.Names, CoreJson.Options);
            row.KeyType = checkedUpload.KeyType;
            row.ChainPem = checkedUpload.ChainPem;
            row.ProtectedKey = keys.ProtectCertificateKey(checkedUpload.PrivateKeyPkcs8);
            System.Security.Cryptography.CryptographicOperations.ZeroMemory(checkedUpload.PrivateKeyPkcs8);
            row.Issuer = checkedUpload.Issuer;
            row.NotBefore = checkedUpload.NotBefore.ToUnixTimeMilliseconds();
            row.NotAfter = checkedUpload.NotAfter.ToUnixTimeMilliseconds();
            row.IssuedAt = Now;
            row.Replaced = null;
            row.RevokedAt = null;
            row.AutoRenew = false;
            ClearRenewalPlan(row);
            await db.SaveChangesAsync(cancellationToken);
        }

        await alerts.ResolveAsync(AlertKind.CertificateRenewalFailed, site.Settings.Id, cancellationToken);
        var apply = await sites.ApplyAsync(who, cancellationToken);
        var info = (await ListAsync(cancellationToken)).First(c => c.SiteId == site.Settings.Id);
        return new CertificateUploadResult([], info, apply);
    }

    /// <summary>Takes the certificate off the site (revoking it first when asked) and applies.</summary>
    public async Task<NginxApplyResult> RemoveAsync(CertificateRemoveRequest request, Requester who, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (!Enum.IsDefined(request.Reason))
        {
            throw new ArgumentException("That is not a revocation reason.", nameof(request));
        }

        SiteCertificate? row;
        await using (var db = await contexts.CreateDbContextAsync(cancellationToken))
        {
            row = await db.Certificates.AsNoTracking().FirstOrDefaultAsync(c => c.SiteId == request.SiteId, cancellationToken);
        }

        if (row is null)
        {
            throw new ArgumentException("This site has no certificate.", nameof(request));
        }

        if (request.Revoke && row is { Source: CertificateViews.AcmeSource, DirectoryUrl: { } directory, RevokedAt: null })
        {
            try
            {
                await issuers.For(new Uri(directory)).RevokeAsync(row.SiteId, ToAcme(request.Reason), cancellationToken);
            }
            catch (AcmeProblemException error) when (error.ErrorType == AcmeErrorType.AlreadyRevoked)
            {
                LogAlreadyRevoked(logger, row.SiteId);
            }
        }

        await using (var db = await contexts.CreateDbContextAsync(cancellationToken))
        {
            await db.Certificates.Where(c => c.SiteId == request.SiteId).ExecuteDeleteAsync(cancellationToken);
        }

        await alerts.ResolveAsync(AlertKind.CertificateRenewalFailed, request.SiteId, cancellationToken);
        return await sites.ApplyAsync(who, cancellationToken);
    }

    /// <summary>A plain sentence for what went wrong, saying what to do where the CA's answer allows.</summary>
    public static string Describe(Exception error)
    {
        ArgumentNullException.ThrowIfNull(error);
        return error switch
        {
            AcmeValidationException { ErrorType: AcmeErrorType.Dns } invalid =>
                $"DNS for {invalid.Domain} does not point here yet: the CA could not look it up ({Detail(invalid)}). Add an A or AAAA record for {invalid.Domain} with this server's address, then try again.",
            AcmeValidationException { ErrorType: AcmeErrorType.Connection } invalid =>
                $"The CA could not reach {invalid.Domain} on port 80 ({Detail(invalid)}). Open port 80 to the internet in the server's firewall and any cloud firewall in front of it.",
            AcmeValidationException { ErrorType: AcmeErrorType.IncorrectResponse or AcmeErrorType.Unauthorized } invalid =>
                $"{invalid.Domain} answered the CA from somewhere else ({Detail(invalid)}): its DNS points at another server, or a proxy in front of it does not pass /.well-known/acme-challenge/ through.",
            AcmeValidationException { ErrorType: AcmeErrorType.Caa } invalid =>
                $"A CAA record on {invalid.Domain} does not allow this CA to issue for it ({Detail(invalid)}).",
            AcmeValidationException invalid => invalid.Message,
            AcmeRateLimitedException limited =>
                $"The CA's rate limit was hit{(limited.RetryAt is { } at ? string.Create(CultureInfo.InvariantCulture, $"; it can be tried again after {at:u}") : string.Empty)}. Use the staging CA while testing. ({limited.Problem.Describe()})",
            AcmeException acme => acme.Message,
            HttpRequestException http => $"The CA could not be reached: {http.Message}",
            _ => error.Message,
        };
    }

    private async Task IssueAsync(CertificateIssueRequest request, Requester who, JobContext job, CancellationToken cancellationToken)
    {
        var site = await RequireSiteAsync(request.SiteId, cancellationToken);
        var domains = site.Settings.Domains;
        var wildcard = domains.Any(domain => domain.StartsWith("*.", StringComparison.Ordinal));
        if ((wildcard || request.PreferDns01) && !await issuers.CanAnswerDns01Async(domains, cancellationToken))
        {
            throw new JobFailedException(
                (wildcard ? "A wildcard domain can only be validated over DNS-01" : "DNS-01 was asked for")
                + ", which needs a Cloudflare DNS token on this server for the zone of every domain of the site. "
                + "On the Cloudflare page, send this server a DNS token for the zone (DNS-01), then issue again.");
        }

        await EnsureSiteLiveAsync(site, who, job, cancellationToken);
        await PreflightAsync(domains, job, cancellationToken);
        var directory = request.Staging ? directories.Staging : directories.Production;
        var issuer = issuers.For(directory);
        job.Log($"Using the ACME account at {directory.Host}{(request.Staging ? " (staging: the certificate will not be trusted by browsers)" : string.Empty)}.");
        try
        {
            await issuer.EnsureAccountAsync(new AcmeAccountSettings(request.ContactEmail is { Length: > 0 } email ? [email] : [], request.AcceptTermsOfService), cancellationToken);

            await issuer.IssueAsync(
                new AcmeIssueRequest { Name = site.Settings.Id, Domains = domains, PreferDns01 = request.PreferDns01 || wildcard },
                new JobProgress(job),
                cancellationToken);
        }
        catch (Exception error) when (error is AcmeException or HttpRequestException)
        {
            await UpdateAsync(site.Settings.Id, row => (row.LastAttemptAt, row.LastError, row.LastJobId) = (Now, Describe(error), job.Id), cancellationToken);
            throw new JobFailedException(Describe(error));
        }

        await UpdateAsync(site.Settings.Id, row => (row.LastAttemptAt, row.LastError, row.LastJobId) = (Now, null, job.Id), cancellationToken);
        await alerts.ResolveAsync(AlertKind.CertificateRenewalFailed, site.Settings.Id, cancellationToken);
        job.Log("The certificate is stored. Switching the site to HTTPS.");
        await ApplyOrFailAsync(who, "The certificate was issued and stored, but nginx refused the site with it", job, cancellationToken);
        job.Log("The site serves its new certificate.");
    }

    private async Task RenewAsync(string siteId, Requester? who, JobContext job, CancellationToken cancellationToken)
    {
        SiteCertificate row;
        await using (var db = await contexts.CreateDbContextAsync(cancellationToken))
        {
            row = await db.Certificates.AsNoTracking().FirstOrDefaultAsync(c => c.SiteId == siteId, cancellationToken)
                ?? throw new JobFailedException("The site no longer has a certificate.");
        }

        var issuer = issuers.For(new Uri(row.DirectoryUrl ?? throw new JobFailedException("This certificate was not issued over ACME.")));
        try
        {
            job.Log($"Renewing the certificate for {string.Join(", ", CertificateViews.DomainsOf(row))}, valid until {DateTimeOffset.FromUnixTimeMilliseconds(row.NotAfter):u}.");
            await issuer.RenewAsync(siteId, new JobProgress(job), cancellationToken);
        }
        catch (Exception error) when (error is AcmeException or HttpRequestException)
        {
            await RecordFailureAsync(row, Describe(error), (error as AcmeProblemException)?.RetryAt, job.Id);
            throw new JobFailedException(Describe(error));
        }

        await UpdateAsync(siteId, saved => (saved.LastAttemptAt, saved.LastError, saved.LastJobId) = (Now, null, job.Id), cancellationToken);
        await alerts.ResolveAsync(AlertKind.CertificateRenewalFailed, siteId, cancellationToken);
        job.Log("Reloading nginx with the renewed certificate.");
        await ApplyOrFailAsync(who, "The certificate was renewed and stored, but nginx refused to load it", job, cancellationToken);
        job.Log("nginx serves the renewed certificate.");
    }

    /// <summary>Counts the failure, waits longer each time (and at least as long as the CA asked), and raises the alert.</summary>
    private async Task RecordFailureAsync(SiteCertificate row, string message, DateTimeOffset? retryAt, Guid jobId)
    {
        var now = time.GetUtcNow();
        var failures = row.FailedAttempts + 1;
        var backoff = TimeSpan.FromTicks(Math.Min(MaxBackoff.Ticks, FirstBackoff.Ticks << Math.Min(failures - 1, 20)));
        var next = now + backoff;
        if (retryAt is { } asked && asked > next)
        {
            next = asked;
        }

        await UpdateAsync(
            row.SiteId,
            saved =>
            {
                saved.FailedAttempts = failures;
                saved.NextAttemptAt = next.ToUnixTimeMilliseconds();
                saved.LastAttemptAt = now.ToUnixTimeMilliseconds();
                saved.LastError = message;
                saved.LastJobId = jobId;
            },
            CancellationToken.None);
        var left = DateTimeOffset.FromUnixTimeMilliseconds(row.NotAfter) - now;
        await alerts.RaiseAsync(
            AlertKind.CertificateRenewalFailed,
            row.SiteId,
            left < CriticalWithin ? AlertSeverity.Critical : AlertSeverity.Warning,
            string.Create(CultureInfo.InvariantCulture, $"Renewing the certificate of {row.SiteId} failed ({failures} in a row; it expires {DateTimeOffset.FromUnixTimeMilliseconds(row.NotAfter):u}). Next try {next:u}. {message}"),
            CancellationToken.None);
        LogRenewalFailed(logger, row.SiteId, failures);
    }

    private async Task EnsureSiteLiveAsync(SiteInfo site, Requester who, JobContext job, CancellationToken cancellationToken)
    {
        if (site.Applied)
        {
            return;
        }

        job.Log("The site has changes nginx does not run yet; applying them so the CA can reach it on port 80.");
        await ApplyOrFailAsync(who, "The site could not be put live, so the CA would not reach it", job, cancellationToken);
    }

    private async Task ApplyOrFailAsync(Requester? who, string what, JobContext job, CancellationToken cancellationToken)
    {
        var apply = await sites.ApplyAsync(who, cancellationToken);
        foreach (var warning in apply.Warnings)
        {
            job.Log(warning, JobLogSource.Err);
        }

        if (!apply.Applied)
        {
            var reason = apply.Error ?? string.Join(" ", apply.Problems.Take(3).Select(p => p.Line is { } line ? $"{p.Field} line {line}: {p.Message}" : $"{p.Field}: {p.Message}"));
            throw new JobFailedException($"{what}: {reason}");
        }
    }

    /// <summary>A warning, not a stop: the CA's own answer says exactly what is wrong, and this server's resolver may differ.</summary>
    private async Task PreflightAsync(IReadOnlyList<string> domains, JobContext job, CancellationToken cancellationToken)
    {
        foreach (var domain in domains)
        {
            try
            {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                timeout.CancelAfter(TimeSpan.FromSeconds(10));
                var addresses = await resolver.ResolveAsync(domain, timeout.Token);
                job.Log(addresses.Length > 0
                    ? $"{domain} resolves to {string.Join(", ", addresses.Select(a => a.ToString()))}."
                    : $"Warning: {domain} resolves to no address; the CA will not find the site.");
            }
            catch (Exception error) when (error is System.Net.Sockets.SocketException or OperationCanceledException && !cancellationToken.IsCancellationRequested)
            {
                job.Log($"Warning: {domain} does not resolve from this server yet. If its DNS record is new, the CA may not see it either.", JobLogSource.Err);
            }
        }
    }

    private async Task<SiteInfo> RequireSiteAsync(string siteId, CancellationToken cancellationToken) =>
        NginxValidator.IsId(siteId) && await sites.GetSiteAsync(siteId, cancellationToken) is { } site
            ? site
            : throw new ArgumentException("There is no such site.", nameof(siteId));

    private async Task UpdateAsync(string siteId, Action<SiteCertificate> change, CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        if (await db.Certificates.FirstOrDefaultAsync(c => c.SiteId == siteId, cancellationToken) is { } row)
        {
            change(row);
            await db.SaveChangesAsync(cancellationToken);
        }
    }

    internal static void ClearRenewalPlan(SiteCertificate row)
    {
        row.RenewAt = null;
        row.WindowStart = null;
        row.WindowEnd = null;
        row.NextCheckAt = null;
        row.ExplanationUrl = null;
        row.FailedAttempts = 0;
        row.NextAttemptAt = null;
        row.LastError = null;
    }

    private static string Detail(AcmeValidationException error) => error.Problem?.Describe() ?? "no detail";

    private static AcmeRevocationReason ToAcme(CertificateRevocationReason reason) => reason switch
    {
        CertificateRevocationReason.KeyCompromise => AcmeRevocationReason.KeyCompromise,
        CertificateRevocationReason.Superseded => AcmeRevocationReason.Superseded,
        CertificateRevocationReason.CessationOfOperation => AcmeRevocationReason.CessationOfOperation,
        _ => AcmeRevocationReason.Unspecified,
    };

    [LoggerMessage(Level = LogLevel.Information, Message = "The certificate of {SiteId} was already revoked at the CA.")]
    private static partial void LogAlreadyRevoked(ILogger logger, string siteId);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Renewing the certificate of {SiteId} failed, {Failures} times in a row.")]
    private static partial void LogRenewalFailed(ILogger logger, string siteId, int failures);

    /// <summary>Each issuance step as a line in the job's log, written at once (Progress&lt;T&gt; would post it later).</summary>
    private sealed class JobProgress(JobContext job) : IProgress<AcmeIssueProgress>
    {
        public void Report(AcmeIssueProgress value) => job.Log(value.Step switch
        {
            AcmeIssueStep.Ordering => "Ordering the certificate from the CA.",
            AcmeIssueStep.PublishingChallenge => $"Publishing the challenge answer for {value.Domain}.",
            AcmeIssueStep.Validating => $"Waiting for the CA to validate {value.Domain}.",
            AcmeIssueStep.Finalizing => "Every domain is validated; sending the signing request.",
            AcmeIssueStep.Downloading => "Downloading the certificate and its chain.",
            _ => "Storing the certificate (its key sealed).",
        });
    }
}
