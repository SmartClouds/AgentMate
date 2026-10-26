using System.Security.Cryptography;
using Microsoft.EntityFrameworkCore;
using Runova.ServerCore.Certificates.Acme;
using Runova.ServerCore.Data;
using Runova.ServerCore.Jobs;

namespace Runova.ServerCore.Certificates;

/// <summary>Tests switch the timer off and run passes themselves.</summary>
internal sealed record CertificateRenewalOptions(bool RunInBackground = true);

/// <summary>
/// Renews Let's Encrypt certificates without the app being open. Every six hours (with jitter, so
/// servers do not all ask the CA at once) it asks the CA for each certificate's renewal window
/// (ARI, RFC 9773) when the last answer said to, picks one moment inside the window and keeps it
/// until the window moves, and renews once that moment has passed. A CA without ARI gets the
/// usual rule: two thirds into the certificate's lifetime. A failed renewal waits longer each time
/// (see <see cref="CertificateService"/>), raises an alert, and is tried again.
/// </summary>
internal sealed partial class CertificateRenewals(
    CertificateRenewalOptions options,
    IDbContextFactory<CoreDbContext> contexts,
    CertificateService certificates,
    ICertificateAuthorities issuers,
    JobEngine jobs,
    TimeProvider time,
    ILogger<CertificateRenewals> logger) : BackgroundService
{
    public static readonly TimeSpan Every = TimeSpan.FromHours(6);

    public static readonly TimeSpan MaxJitter = TimeSpan.FromMinutes(30);

    /// <summary>When a CA without ARI is asked again whether it has added it.</summary>
    private static readonly TimeSpan _withoutRenewalInfo = TimeSpan.FromDays(1);

    /// <summary>One pass: plans every certificate and renews the ones that are due, one at a time.</summary>
    /// <returns>How many renewals ran.</returns>
    public async Task<int> RunOnceAsync(CancellationToken cancellationToken)
    {
        List<SiteCertificate> rows;
        await using (var db = await contexts.CreateDbContextAsync(cancellationToken))
        {
            rows = await db.Certificates.AsNoTracking()
                .Where(c => c.Source == CertificateViews.AcmeSource && c.AutoRenew && c.RevokedAt == null && c.DirectoryUrl != null)
                .OrderBy(c => c.SiteId)
                .ToListAsync(cancellationToken);
        }

        var renewed = 0;
        foreach (var row in rows)
        {
            var now = time.GetUtcNow();
            if (row.NextAttemptAt is { } wait && wait > now.ToUnixTimeMilliseconds())
            {
                continue;
            }

            var renewAt = await PlanAsync(row, now, cancellationToken);
            if (renewAt > now)
            {
                continue;
            }

            try
            {
                var job = await certificates.StartRenewAsync(row.SiteId, who: null, cancellationToken);
                await jobs.WhenFinishedAsync(job.Id, cancellationToken);
                renewed++;
            }
            catch (JobConflictException)
            {
                // Someone is already renewing or issuing for this site.
            }
        }

        return renewed;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.RunInBackground)
        {
            return;
        }

        // A first pass soon after start, so a core that was down through a renewal catches up.
        var delay = TimeSpan.FromMinutes(1) + Jitter();
        while (!stoppingToken.IsCancellationRequested)
        {
            await Task.Delay(delay, time, stoppingToken);
            try
            {
                await RunOnceAsync(stoppingToken);
            }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                LogPassFailed(logger, error);
            }

            delay = Every + Jitter();
        }
    }

    /// <summary>The renewal moment, from the CA's window when it is time to ask, from the stored plan otherwise.</summary>
    private async Task<DateTimeOffset> PlanAsync(SiteCertificate row, DateTimeOffset now, CancellationToken cancellationToken)
    {
        var nowMs = now.ToUnixTimeMilliseconds();
        long? renewAt = row.RenewAt;
        long? windowStart = row.WindowStart;
        long? windowEnd = row.WindowEnd;
        string? explanation = row.ExplanationUrl;
        long nextCheck;
        if (row.NextCheckAt is null || row.NextCheckAt <= nowMs)
        {
            try
            {
                var info = await issuers.For(new Uri(row.DirectoryUrl!)).GetRenewalInfoAsync(row.SiteId, cancellationToken);
                var start = info.WindowStart.ToUnixTimeMilliseconds();
                var end = info.WindowEnd.ToUnixTimeMilliseconds();
                if (start != windowStart || end != windowEnd || renewAt is null)
                {
                    renewAt = info.PickRenewalTime().ToUnixTimeMilliseconds();
                    (windowStart, windowEnd) = (start, end);
                }

                explanation = info.ExplanationUrl?.AbsoluteUri;
                nextCheck = info.NextCheckAt.ToUnixTimeMilliseconds();
            }
            catch (Exception error) when (error is AcmeException or HttpRequestException)
            {
                LogNoRenewalInfo(logger, row.SiteId, error.Message);
                renewAt ??= row.NotBefore + ((row.NotAfter - row.NotBefore) * 2 / 3);
                nextCheck = nowMs + (long)_withoutRenewalInfo.TotalMilliseconds;
            }

            await using var db = await contexts.CreateDbContextAsync(cancellationToken);
            await db.Certificates.Where(c => c.SiteId == row.SiteId).ExecuteUpdateAsync(
                update => update
                    .SetProperty(c => c.RenewAt, renewAt)
                    .SetProperty(c => c.WindowStart, windowStart)
                    .SetProperty(c => c.WindowEnd, windowEnd)
                    .SetProperty(c => c.ExplanationUrl, explanation)
                    .SetProperty(c => c.NextCheckAt, nextCheck),
                cancellationToken);
        }

        return DateTimeOffset.FromUnixTimeMilliseconds(renewAt ?? row.NotBefore + ((row.NotAfter - row.NotBefore) * 2 / 3));
    }

    private static TimeSpan Jitter() => TimeSpan.FromSeconds(RandomNumberGenerator.GetInt32((int)MaxJitter.TotalSeconds));

    [LoggerMessage(Level = LogLevel.Warning, Message = "A certificate renewal pass failed; the next pass tries again.")]
    private static partial void LogPassFailed(ILogger logger, Exception error);

    [LoggerMessage(Level = LogLevel.Information, Message = "No renewal window for the certificate of {SiteId} ({Reason}); planning by its lifetime.")]
    private static partial void LogNoRenewalInfo(ILogger logger, string siteId, string reason);
}
