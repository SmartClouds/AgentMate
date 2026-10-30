using Microsoft.EntityFrameworkCore;
using Runova.Website.Api.Audit;
using Runova.Website.Core.Audit;
using Runova.Website.Core.News;
using Runova.Website.Data;

namespace Runova.Website.Api.News;

/// <summary>
/// Publishes the scheduled news items and posts whose time has come. The public reads already
/// hide one until its <c>publishedAt</c>; this makes its status say so too, and audits each one.
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

        var duePosts = await db.Posts
            .Where(p => p.Status == NewsStatus.Scheduled && p.PublishedAt <= now)
            .ToListAsync(cancellationToken);
        foreach (var post in duePosts)
        {
            post.Status = NewsStatus.Published;
            post.UpdatedAt = now;
            audit.AddBySystem(AuditActions.PostPublish, AuditTargetTypes.Post, post.Id, new { publishedAt = post.PublishedAt });
        }

        await db.SaveChangesAsync(cancellationToken);
        LogPublished(logger, due.Count, duePosts.Count);
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Published {News} scheduled news items and {Posts} scheduled posts")]
    private static partial void LogPublished(ILogger logger, int news, int posts);
}
