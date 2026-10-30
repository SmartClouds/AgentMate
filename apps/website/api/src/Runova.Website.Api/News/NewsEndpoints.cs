using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;
using Runova.Website.Api.Http;
using Runova.Website.Api.Identity;
using Runova.Website.Api.Paging;
using Runova.Website.Api.Problems;
using Runova.Website.Core.Caching;
using Runova.Website.Core.Content;
using Runova.Website.Core.News;
using Runova.Website.Core.Paging;
using Runova.Website.Core.Problems;
using Runova.Website.Data;
using Runova.Website.Data.News;

namespace Runova.Website.Api.News;

/// <summary>
/// Reading technology news. Anyone sees what is published and due; only staff may list other
/// statuses, and those lists are never kept by a shared cache.
/// </summary>
internal static class NewsEndpoints
{
    // At least one letter, so a slug never looks like the id the write routes will take.
    private const string SlugRoute = "{slug:regex(^[a-z0-9-]*[a-z][a-z0-9-]*$)}";

    public static IServiceCollection AddWebsiteNews(this IServiceCollection services) =>
        services.AddSingleton(provider => new MarkdownRenderer(new Uri(SiteUrl.From(provider.GetRequiredService<IConfiguration>()))));

    public static RouteGroupBuilder MapNews(this RouteGroupBuilder api)
    {
        var news = api.MapGroup("/news").AllowAnonymous();
        news.MapGet("", ListAsync).Produces(StatusCodes.Status304NotModified);
        news.MapGet($"/{SlugRoute}", GetAsync).Produces(StatusCodes.Status304NotModified);
        return api;
    }

    private static async Task<Results<Ok<Page<NewsListItemDto>>, StatusCodeHttpResult, ValidationProblem, ProblemHttpResult>> ListAsync(
        string[]? category,
        string[]? severity,
        string? minSeverity,
        string[]? technology,
        string[]? tag,
        string? since,
        string? q,
        string? sort,
        string[]? status,
        int? page,
        int? pageSize,
        AppDbContext db,
        TimeProvider time,
        IAuthorizationService authorization,
        IConfiguration configuration,
        HttpContext http)
    {
        var query = NewsListQuery.Parse(
            new NewsListParameters(category, severity, minSeverity, technology, tag, since, q, sort, status, page, pageSize),
            out var errors);
        if (errors.Count > 0)
        {
            return ApiProblems.Invalid(errors);
        }

        var cacheControl = HttpCaching.PublicList;
        if (query.Statuses.Count > 0)
        {
            if (http.User.Identity?.IsAuthenticated != true)
            {
                return ApiProblems.Of(ProblemTypes.Unauthorized, "Sign in to list news by status.");
            }

            if (!(await authorization.AuthorizeAsync(http.User, Policies.Staff)).Succeeded)
            {
                return ApiProblems.Of(ProblemTypes.Forbidden, "Only staff can list news by status.");
            }

            cacheControl = HttpCaching.Private;
        }

        var matching = db.NewsItems.AsNoTracking().Filter(query, time.GetUtcNow());
        var summary = await matching
            .GroupBy(_ => 1)
            .Select(g => new { Count = g.Count(), Newest = g.Max(i => (DateTimeOffset?)i.UpdatedAt) })
            .SingleOrDefaultAsync();
        var total = summary?.Count ?? 0;

        // Checked before the page is read, so a client with a fresh copy costs one small query.
        var etag = ETags.ForList($"{http.Request.Path}{http.Request.QueryString}", summary?.Newest, total);
        if (HttpCaching.IsNotModified(http, etag, cacheControl))
        {
            return TypedResults.StatusCode(StatusCodes.Status304NotModified);
        }

        var items = await matching.Sort(query.Sort).Skip(query.Page.Skip).Take(query.Page.Size).ToListAsync();
        var siteUrl = SiteUrl.From(configuration);
        var result = Page.Of([.. items.Select(i => NewsMapper.ToListItemDto(i, ItemUrl(siteUrl, i)))], query.Page, total);
        PageLinks.Set(http, result);
        return TypedResults.Ok(result);
    }

    private static async Task<Results<Ok<NewsItemDto>, StatusCodeHttpResult, ProblemHttpResult>> GetAsync(
        string slug, AppDbContext db, TimeProvider time, IConfiguration configuration, HttpContext http)
    {
        var item = await db.NewsItems.AsNoTracking().Public(time.GetUtcNow()).SingleOrDefaultAsync(i => i.Slug == slug);
        if (item is null)
        {
            return ApiProblems.Of(ProblemTypes.NotFound, "There is no published news item with this slug.");
        }

        if (HttpCaching.IsNotModified(http, Versions.ETag(item.Version), HttpCaching.PublicItem))
        {
            return TypedResults.StatusCode(StatusCodes.Status304NotModified);
        }

        return TypedResults.Ok(NewsMapper.ToDto(item, ItemUrl(SiteUrl.From(configuration), item)));
    }

    private static string ItemUrl(string siteUrl, NewsItem item) => $"{siteUrl}/news/{item.Slug}";
}
