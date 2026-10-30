using System.Linq.Expressions;
using Hangfire;
using Runova.Website.Api.ApiClients;
using Runova.Website.Api.News;
using Runova.Website.Api.Users;

namespace Runova.Website.Api.Jobs;

/// <summary>
/// Every recurring job, by a fixed id, with its schedule. Schedules are cron expressions in UTC.
/// </summary>
internal static class RecurringJobRegistry
{
    public const string InvitationsCleanup = "invitations-cleanup";
    public const string NewsPublish = "news-publish";
    public const string SignatureNoncesPurge = "signature-nonces-purge";
    public const string IdempotencyPurge = "idempotency-purge";

    public static readonly IReadOnlyDictionary<string, string> Schedules = new Dictionary<string, string>
    {
        [InvitationsCleanup] = Cron.Hourly(),
        [NewsPublish] = Cron.Minutely(),
        [SignatureNoncesPurge] = Cron.MinuteInterval(10),
        [IdempotencyPurge] = Cron.Hourly(),
    };

    /// <summary>Adds each job, or updates it when its schedule or method changed.</summary>
    public static void Register(IRecurringJobManager jobs)
    {
        Add<InvitationsCleanupJob>(jobs, InvitationsCleanup, job => job.RunAsync(CancellationToken.None));
        Add<NewsPublishJob>(jobs, NewsPublish, job => job.RunAsync(CancellationToken.None));
        Add<SignatureNoncesPurgeJob>(jobs, SignatureNoncesPurge, job => job.RunAsync(CancellationToken.None));
        Add<IdempotencyPurgeJob>(jobs, IdempotencyPurge, job => job.RunAsync(CancellationToken.None));
    }

    // Hangfire passes its own shutdown token in place of CancellationToken.None.
    private static void Add<TJob>(IRecurringJobManager jobs, string id, Expression<Func<TJob, Task>> run) =>
        jobs.AddOrUpdate(id, run, Schedules[id], new RecurringJobOptions { TimeZone = TimeZoneInfo.Utc });
}
