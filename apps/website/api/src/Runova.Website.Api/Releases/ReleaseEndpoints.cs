using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;
using Runova.Website.Api.Http;
using Runova.Website.Api.Problems;
using Runova.Website.Core;
using Runova.Website.Core.Caching;
using Runova.Website.Core.Problems;
using Runova.Website.Core.Releases;
using Runova.Website.Data;

namespace Runova.Website.Api.Releases;

/// <summary>
/// The latest desktop release, its assets and a redirect to the right file for a platform. All of
/// it comes from what <see cref="ReleasesSyncJob"/> stored, so GitHub being down changes nothing here.
/// </summary>
internal static class ReleaseEndpoints
{
    /// <summary>The GitHub client the sync job reads releases with.</summary>
    public static IServiceCollection AddWebsiteReleases(this IServiceCollection services)
    {
        services.AddHttpClient<GitHubReleasesClient>(GitHubReleasesClient.Configure);
        return services;
    }

    public static RouteGroupBuilder MapReleases(this RouteGroupBuilder api)
    {
        var latest = api.MapGroup("/releases/latest").AllowAnonymous();
        latest.MapGet("", GetAsync).Produces(StatusCodes.Status304NotModified);
        latest.MapGet("/assets", AssetsAsync).Produces(StatusCodes.Status304NotModified);
        latest.MapGet("/downloads/{platform}", DownloadAsync);
        return api;
    }

    private static async Task<Results<Ok<ReleaseDto>, StatusCodeHttpResult, ProblemHttpResult>> GetAsync(AppDbContext db, HttpContext http)
    {
        if (await LatestAsync(db) is not { } release)
        {
            return NoRelease();
        }

        if (HttpCaching.IsNotModified(http, Versions.ETag(release.RowVersion), HttpCaching.PublicItem))
        {
            return TypedResults.StatusCode(StatusCodes.Status304NotModified);
        }

        return TypedResults.Ok(ReleaseMapper.ToDto(release));
    }

    private static async Task<Results<Ok<List<ReleaseAssetDto>>, StatusCodeHttpResult, ValidationProblem, ProblemHttpResult>> AssetsAsync(
        string? platform, string? arch, string? kind, AppDbContext db, HttpContext http)
    {
        var errors = new Dictionary<string, string[]>();
        var platformFilter = Parse<ReleasePlatform>(platform, "platform", errors);
        var archFilter = Parse<ReleaseArch>(arch, "arch", errors);
        var kindFilter = Parse<ReleaseKind>(kind, "kind", errors);
        if (errors.Count > 0)
        {
            return ApiProblems.Invalid(errors);
        }

        if (await LatestAsync(db) is not { } release)
        {
            return NoRelease();
        }

        var assets = release.Assets
            .Where(a => (platformFilter is null || a.Platform == platformFilter)
                && (archFilter is null || a.Arch == archFilter)
                && (kindFilter is null || a.Kind == kindFilter))
            .Select(ReleaseMapper.ToDto)
            .ToList();
        var etag = ETags.ForList($"{http.Request.Path}{http.Request.QueryString}", release.FetchedAt, assets.Count);
        if (HttpCaching.IsNotModified(http, etag, HttpCaching.PublicItem))
        {
            return TypedResults.StatusCode(StatusCodes.Status304NotModified);
        }

        return TypedResults.Ok(assets);
    }

    private static async Task<Results<RedirectHttpResult, ProblemHttpResult>> DownloadAsync(
        string platform, string? arch, string? kind, AppDbContext db, HttpContext http)
    {
        // An unknown arch or kind can name no asset, so it is a 404 like a missing one.
        if (!ApiEnums.TryParse<ReleasePlatform>(platform, out var parsedPlatform))
        {
            return ApiProblems.Of(ProblemTypes.NotFound, "There is no such platform. Use windows, macos or linux.");
        }

        ReleaseArch? parsedArch = null;
        ReleaseKind? parsedKind = null;
        if ((arch is not null && !TryParse(arch, out parsedArch)) || (kind is not null && !TryParse(kind, out parsedKind)))
        {
            return NoAsset();
        }

        if (await LatestAsync(db) is not { } release)
        {
            return NoRelease();
        }

        if (DesktopAssets.Best(release.Assets, parsedPlatform, parsedArch, parsedKind) is not { } asset)
        {
            return NoAsset();
        }

        http.Response.Headers.CacheControl = HttpCaching.PublicItem;
        return TypedResults.Redirect(asset.DownloadUrl);
    }

    /// <summary>
    /// The newest release stored, with only the assets that are the desktop app by their name, so
    /// nothing else can come out even if it were ever stored.
    /// </summary>
    private static async Task<Release?> LatestAsync(AppDbContext db)
    {
        var release = await db.Releases.AsNoTracking().OrderByDescending(r => r.FetchedAt).FirstOrDefaultAsync();
        release?.Assets = [.. release.Assets.Where(a => DesktopAssets.Classify(a.Name, release.Version) == new DesktopAssetType(a.Platform, a.Arch, a.Kind))];
        return release;
    }

    private static T? Parse<T>(string? text, string parameter, Dictionary<string, string[]> errors)
        where T : struct, Enum
    {
        if (text is null)
        {
            return null;
        }

        if (TryParse<T>(text, out var value))
        {
            return value;
        }

        errors[parameter] = [$"Unknown {parameter} '{text}'."];
        return null;
    }

    private static bool TryParse<T>(string text, out T? value)
        where T : struct, Enum
    {
        var parsed = ApiEnums.TryParse<T>(text, out var item);
        value = parsed ? item : null;
        return parsed;
    }

    private static ProblemHttpResult NoRelease() =>
        ApiProblems.Of(ProblemTypes.Unavailable, "No desktop release has been read from GitHub yet. Try again later.");

    private static ProblemHttpResult NoAsset() =>
        ApiProblems.Of(ProblemTypes.NotFound, "The latest release has no file for this platform, arch and kind.");
}
