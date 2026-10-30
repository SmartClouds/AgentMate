using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Runova.Website.Core.Content;
using Runova.Website.Core.News;
using Runova.Website.Core.Posts;
using Runova.Website.Data;

namespace Runova.Website.IntegrationTests.Infrastructure;

/// <summary>Blog posts written straight to the database, for tests that need a post in a state or at a time the API would refuse.</summary>
internal static class TestPosts
{
    /// <summary>A valid post: published at the given time unless told otherwise.</summary>
    public static Post Item(
        string slug,
        DateTimeOffset? publishedAt,
        NewsStatus status = NewsStatus.Published,
        string? title = null,
        string body = "Nothing out of the ordinary.",
        string[]? tags = null) => new()
        {
            Slug = slug,
            Title = title ?? $"Test post {slug}",
            Excerpt = $"An excerpt of {slug} that is long enough.",
            BodyMarkdown = body,
            AuthorName = "Sam Writer",
            Tags = [.. (tags ?? []).Select(t => new Tag { Slug = Tag.SlugFor(t), Name = t })],
            Status = status,
            PublishedAt = publishedAt,
            ReadingTimeMinutes = ReadingTime.Minutes(body),
            UpdatedAt = publishedAt ?? DateTimeOffset.UnixEpoch,
        };

    /// <summary>Saves the posts with their bodies rendered, reusing a tag another post already has.</summary>
    public static async Task AddAsync(IServiceProvider services, params Post[] posts)
    {
        using var scope = services.CreateScope();
        var renderer = scope.ServiceProvider.GetRequiredService<MarkdownRenderer>();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var tags = await db.Tags.ToDictionaryAsync(t => t.Slug, TestContext.Current.CancellationToken);
        foreach (var post in posts)
        {
            post.BodyHtml = renderer.Render(post.BodyMarkdown);
            post.Tags = [.. post.Tags.Select(t => tags.TryGetValue(t.Slug, out var known) ? known : tags[t.Slug] = t)];
        }

        db.Posts.AddRange(posts);
        await db.SaveChangesAsync(TestContext.Current.CancellationToken);
    }
}
