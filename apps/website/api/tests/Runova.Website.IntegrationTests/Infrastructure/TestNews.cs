using Microsoft.Extensions.DependencyInjection;
using Runova.Website.Core.Content;
using Runova.Website.Core.News;
using Runova.Website.Data;

namespace Runova.Website.IntegrationTests.Infrastructure;

/// <summary>
/// News items written straight to the database, for tests that need an item in a state or at a time
/// the write endpoints would refuse (an archived one, or one already due).
/// </summary>
internal static class TestNews
{
    /// <summary>A valid item: published at the given time unless told otherwise, with a body to search.</summary>
    public static NewsItem Item(
        string slug,
        DateTimeOffset? publishedAt,
        NewsStatus status = NewsStatus.Published,
        NewsCategory category = NewsCategory.Industry,
        NewsSeverity severity = NewsSeverity.Info,
        string? title = null,
        string? summary = null,
        string body = "Nothing out of the ordinary.",
        string[]? technologies = null,
        string[]? tags = null) => new()
        {
            Slug = slug,
            Title = title ?? $"Test item {slug}",
            Summary = summary ?? $"A summary of {slug} that is long enough.",
            BodyMarkdown = body,
            Category = category,
            Severity = severity,
            Technologies = [.. (technologies ?? []).Select(t => new AffectedTechnology { Technology = t, VersionRange = "*" })],
            Tags = [.. tags ?? []],
            Status = status,
            PublishedAt = publishedAt,
            UpdatedAt = publishedAt ?? DateTimeOffset.UnixEpoch,
        };

    /// <summary>Saves the items with their bodies rendered, as a write would, and gives them their ids.</summary>
    public static async Task AddAsync(IServiceProvider services, params NewsItem[] items)
    {
        using var scope = services.CreateScope();
        var renderer = scope.ServiceProvider.GetRequiredService<MarkdownRenderer>();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        foreach (var item in items)
        {
            item.BodyHtml = renderer.Render(item.BodyMarkdown);
        }

        db.NewsItems.AddRange(items);
        await db.SaveChangesAsync(TestContext.Current.CancellationToken);
    }
}
