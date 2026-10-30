using Microsoft.EntityFrameworkCore;
using NpgsqlTypes;
using Runova.Website.Core.News;
using Runova.Website.Core.Posts;

namespace Runova.Website.Data.Posts;

public static class PostQueries
{
    /// <summary>What anyone may read: published posts whose time has come.</summary>
    public static IQueryable<Post> Public(this IQueryable<Post> posts, DateTimeOffset now) =>
        posts.Where(p => p.Status == NewsStatus.Published && p.PublishedAt <= now);

    /// <summary>The posts with their cover and their tags in slug order, as every DTO shows them.</summary>
    public static IQueryable<Post> WithCoverAndTags(this IQueryable<Post> posts) =>
        posts.Include(p => p.CoverMedia).Include(p => p.Tags.OrderBy(t => t.Slug));

    /// <summary>
    /// The posts a list query matches, in no order. With no statuses it is the public view; with
    /// statuses (staff only) it is every post in one of them, whatever its time.
    /// </summary>
    public static IQueryable<Post> Filter(this IQueryable<Post> posts, PostListQuery query, DateTimeOffset now)
    {
        posts = query.Statuses.Count == 0 ? posts.Public(now) : posts.Where(p => query.Statuses.Contains(p.Status));

        if (query.Tags.Count > 0)
        {
            posts = posts.Where(p => p.Tags.Any(t => query.Tags.Contains(t.Slug)));
        }

        if (query.Search is { } search)
        {
            posts = posts.Where(p => EF.Property<NpgsqlTsVector>(p, PostsModel.SearchVector).Matches(EF.Functions.WebSearchToTsQuery("english", search)));
        }

        return posts;
    }

    /// <summary>Newest first, the id breaking ties so pages never overlap.</summary>
    public static IOrderedQueryable<Post> Newest(this IQueryable<Post> posts) =>
        posts.OrderByDescending(p => p.PublishedAt).ThenByDescending(p => p.Id);
}
