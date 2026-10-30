using Microsoft.EntityFrameworkCore;
using NpgsqlTypes;
using Runova.Website.Core.News;

namespace Runova.Website.Data.News;

public static class NewsQueries
{
    /// <summary>What anyone may read: published items whose time has come.</summary>
    public static IQueryable<NewsItem> Public(this IQueryable<NewsItem> items, DateTimeOffset now) =>
        items.Where(i => i.Status == NewsStatus.Published && i.PublishedAt <= now);

    /// <summary>
    /// The items a list query matches, in no order. With no statuses it is the public view;
    /// with statuses (staff only) it is every item in one of them, whatever its time.
    /// </summary>
    public static IQueryable<NewsItem> Filter(this IQueryable<NewsItem> items, NewsListQuery query, DateTimeOffset now)
    {
        items = query.Statuses.Count == 0 ? items.Public(now) : items.Where(i => query.Statuses.Contains(i.Status));

        if (query.Categories.Count > 0)
        {
            items = items.Where(i => query.Categories.Contains(i.Category));
        }

        if (query.Severities.Count > 0)
        {
            items = items.Where(i => query.Severities.Contains(i.Severity));
        }

        if (query.MinSeverity is { } min)
        {
            items = items.Where(i => i.Severity >= min);
        }

        if (query.Technologies.Count > 0)
        {
            items = items.Where(i => i.Technologies.Any(t => query.Technologies.Contains(t.Technology)));
        }

        if (query.Tags.Count > 0)
        {
            items = items.Where(i => i.Tags.Any(t => query.Tags.Contains(t)));
        }

        if (query.Since is { } since)
        {
            items = items.Where(i => i.PublishedAt >= since);
        }

        if (query.Search is { } search)
        {
            items = items.Where(i => EF.Property<NpgsqlTsVector>(i, NewsModel.SearchVector).Matches(EF.Functions.WebSearchToTsQuery("english", search)));
        }

        return items;
    }

    /// <summary>Orders by the query's sort, the id breaking ties so pages never overlap.</summary>
    public static IOrderedQueryable<NewsItem> Sort(this IQueryable<NewsItem> items, NewsSort sort) => sort switch
    {
        NewsSort.Oldest => items.OrderBy(i => i.PublishedAt).ThenBy(i => i.Id),
        NewsSort.Severity => items.OrderByDescending(i => i.Severity).ThenByDescending(i => i.PublishedAt).ThenByDescending(i => i.Id),
        _ => items.OrderByDescending(i => i.PublishedAt).ThenByDescending(i => i.Id),
    };
}
