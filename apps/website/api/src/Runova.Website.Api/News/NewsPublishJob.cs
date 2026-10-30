using Microsoft.EntityFrameworkCore;
using Runova.Website.Api.Audit;
using Runova.Website.Core.Audit;
using Runova.Website.Core.News;
using Runova.Website.Data;

namespace Runova.Website.Api.News;

/// <summary>
/// Publishes the scheduled items whose time has come. The public reads already hide an item
/// until its <c>publishedAt</c>; this makes its status say so too, and audits each one.
/// </summary>
internal sealed partial class NewsPublishJob(AppDbContext db, AuditLog audit, TimeProvider time, ILogger<NewsPublishJob> logger)
{
    public async Task RunAsync(CancellationToken cancellationToken)
    {
        var now = time.GetUtcNow();
        var due = await db.NewsItems
            .Where(i => i.Status == NewsStatus.Scheduled && i.PublishedAt <= now)
            .ToListAsync(cancellationToken);
        foreach (var item in due)
        {
            item.Status = NewsStatus.Published;
            item.UpdatedAt = now;
            audit.AddBySystem(AuditActions.NewsPublish, AuditTargetTypes.News, item.Id, new { publishedAt = item.PublishedAt });
        }

        await db.SaveChangesAsync(cancellationToken);
        LogPublished(logger, due.Count);
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Published {Count} scheduled news items")]
    private static partial void LogPublished(ILogger logger, int count);
}
