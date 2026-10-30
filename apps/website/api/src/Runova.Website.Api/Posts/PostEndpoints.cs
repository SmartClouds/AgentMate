using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;
using Runova.Website.Api.Http;
using Runova.Website.Api.Identity;
using Runova.Website.Api.Media;
using Runova.Website.Api.Paging;
using Runova.Website.Api.Problems;
using Runova.Website.Core.Caching;
using Runova.Website.Core.Media;
using Runova.Website.Core.News;
using Runova.Website.Core.Paging;
using Runova.Website.Core.Posts;
using Runova.Website.Core.Problems;
using Runova.Website.Data;
using Runova.Website.Data.Posts;

namespace Runova.Website.Api.Posts;

/// <summary>
/// Reading the blog. Anyone sees what is published and due, and the tags those posts carry; only
/// staff may list other statuses, and those lists are never kept by a shared cache.
/// </summary>
internal static class PostEndpoints
{
    // At least one letter, so a slug never looks like the id the write routes take.
    private const string SlugRoute = "{slug:regex(^[a-z0-9-]*[a-z][a-z0-9-]*$)}";

    public static RouteGroupBuilder MapPosts(this RouteGroupBuilder api)
    {
        var posts = api.MapGroup("/posts").AllowAnonymous();
        posts.MapGet("", ListAsync).Produces(StatusCodes.Status304NotModified);
        posts.MapGet($"/{SlugRoute}", GetAsync).Produces(StatusCodes.Status304NotModified);
        api.MapGet("/tags", ListTagsAsync).AllowAnonymous().Produces(StatusCodes.Status304NotModified);
        return api.MapPostWrites();
    }

    private static async Task<Results<Ok<Page<PostListItemDto>>, StatusCodeHttpResult, ValidationProblem, ProblemHttpResult>> ListAsync(
        string[]? tag,
        string? q,
        string[]? status,
        int? page,
        int? pageSize,
        AppDbContext db,
        TimeProvider time,
        IAuthorizationService authorization,
        IConfiguration configuration,
        HttpContext http)
    {
        var query = PostListQuery.Parse(tag, q, status, page, pageSize, out var errors);
        if (errors.Count > 0)
        {
            return ApiProblems.Invalid(errors);
        }

        var cacheControl = HttpCaching.PublicList;
        if (query.Statuses.Count > 0)
        {
            if (http.User.Identity?.IsAuthenticated != true)
            {
                return ApiProblems.Of(ProblemTypes.Unauthorized, "Sign in to list posts by status.");
            }

            if (!(await authorization.AuthorizeAsync(http.User, Policies.PostsWrite)).Succeeded)
            {
                return ApiProblems.Of(ProblemTypes.Forbidden, "Only staff and API clients that write posts can list them by status.");
            }

            cacheControl = HttpCaching.Private;
        }

        var matching = db.Posts.AsNoTracking().Filter(query, time.GetUtcNow());
        var summary = await matching
            .GroupBy(_ => 1)
            .Select(g => new { Count = g.Count(), Newest = g.Max(p => (DateTimeOffset?)p.UpdatedAt) })
            .SingleOrDefaultAsync();
        var total = summary?.Count ?? 0;

        // Checked before the page is read, so a client with a fresh copy costs one small query.
        var etag = ETags.ForList($"{http.Request.Path}{http.Request.QueryString}", summary?.Newest, total);
        if (HttpCaching.IsNotModified(http, etag, cacheControl))
        {
            return TypedResults.StatusCode(StatusCodes.Status304NotModified);
        }

        var posts = await matching.WithCoverAndTags().Newest().Skip(query.Page.Skip).Take(query.Page.Size).ToListAsync();
        var siteUrl = SiteUrl.From(configuration);
        var result = Page.Of([.. posts.Select(p => PostMapper.ToListItemDto(p, PostUrl(siteUrl, p), CoverImage(siteUrl, p.CoverMedia)))], query.Page, total);
        PageLinks.Set(http, result);
        return TypedResults.Ok(result);
    }

    private static async Task<Results<Ok<PostDto>, StatusCodeHttpResult, ProblemHttpResult>> GetAsync(
        string slug, AppDbContext db, TimeProvider time, IConfiguration configuration, HttpContext http)
    {
        var post = await db.Posts.AsNoTracking().Public(time.GetUtcNow()).WithCoverAndTags().SingleOrDefaultAsync(p => p.Slug == slug);
        if (post is null)
        {
            return ApiProblems.Of(ProblemTypes.NotFound, "There is no published post with this slug.");
        }

        if (HttpCaching.IsNotModified(http, Versions.ETag(post.Version), HttpCaching.PublicItem))
        {
            return TypedResults.StatusCode(StatusCodes.Status304NotModified);
        }

        var siteUrl = SiteUrl.From(configuration);
        return TypedResults.Ok(PostMapper.ToDto(post, PostUrl(siteUrl, post), CoverImage(siteUrl, post.CoverMedia)));
    }

    /// <summary>The tags of published posts, by slug, with how many each carries. A tag no published post has is left out.</summary>
    private static async Task<Results<Ok<List<TagDto>>, StatusCodeHttpResult>> ListTagsAsync(
        AppDbContext db, TimeProvider time, HttpContext http)
    {
        var now = time.GetUtcNow();
        var counted = await db.Tags.AsNoTracking()
            .Select(t => new { t.Slug, t.Name, Count = t.Posts.Count(p => p.Status == NewsStatus.Published && p.PublishedAt <= now) })
            .Where(t => t.Count > 0)
            .OrderBy(t => t.Slug)
            .ToListAsync();
        var tags = counted.Select(t => new TagDto(t.Slug, t.Name, t.Count)).ToList();

        var etag = ETags.ForContent(string.Join('\n', tags.Select(t => $"{t.Slug}\t{t.Name}\t{t.PostCount}")));
        if (HttpCaching.IsNotModified(http, etag, HttpCaching.PublicList))
        {
            return TypedResults.StatusCode(StatusCodes.Status304NotModified);
        }

        return TypedResults.Ok(tags);
    }

    public static string PostUrl(string siteUrl, Post post) => $"{siteUrl}/blog/{post.Slug}";

    public static CoverImageDto? CoverImage(string siteUrl, MediaFile? cover) =>
        cover is null ? null : MediaMapper.ToCoverImageDto(cover, MediaStorage.Url(siteUrl, cover));
}
