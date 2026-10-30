using Microsoft.Extensions.Primitives;
using Microsoft.Net.Http.Headers;

namespace Runova.Website.Api.Http;

/// <summary>The contract's <c>Cache-Control</c> values and the <c>If-None-Match</c> check behind a 304.</summary>
internal static class HttpCaching
{
    public const string PublicList = "public, max-age=60, stale-while-revalidate=300";
    public const string PublicItem = "public, max-age=300, stale-while-revalidate=600";

    /// <summary>For anything only staff or an API client can see.</summary>
    public const string Private = "private, no-store";

    /// <summary>
    /// Sets <c>ETag</c> and <c>Cache-Control</c>, and says whether <c>If-None-Match</c> already
    /// names the tag (weak comparison, as RFC 9110 asks), so the caller answers 304 with no body.
    /// </summary>
    public static bool IsNotModified(HttpContext http, string etag, string cacheControl)
    {
        http.Response.Headers.ETag = etag;
        http.Response.Headers.CacheControl = cacheControl;
        return Matches(http.Request.Headers.IfNoneMatch, EntityTagHeaderValue.Parse(etag));
    }

    private static bool Matches(StringValues ifNoneMatch, EntityTagHeaderValue current) =>
        ifNoneMatch.Count > 0
        && EntityTagHeaderValue.TryParseList(ifNoneMatch, out var tags)
        && tags.Any(t => t.Equals(EntityTagHeaderValue.Any) || t.Compare(current, useStrongComparison: false));
}
