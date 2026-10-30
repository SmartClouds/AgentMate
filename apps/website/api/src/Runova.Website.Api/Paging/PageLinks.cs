using System.Globalization;
using Microsoft.Net.Http.Headers;
using Runova.Website.Core.Paging;

namespace Runova.Website.Api.Paging;

internal static class PageLinks
{
    /// <summary>
    /// Sets the RFC 8288 <c>Link</c> header with <c>first</c>, <c>prev</c>, <c>next</c> and
    /// <c>last</c> where they exist, each the request's path and query with another <c>page</c>.
    /// </summary>
    public static void Set<T>(HttpContext http, Page<T> page)
    {
        var links = new List<string> { Link(http.Request, 1, "first") };
        if (page.Number > 1)
        {
            links.Add(Link(http.Request, page.Number - 1, "prev"));
        }

        if (page.Number < page.TotalPages)
        {
            links.Add(Link(http.Request, page.Number + 1, "next"));
        }

        if (page.TotalPages > 0)
        {
            links.Add(Link(http.Request, page.TotalPages, "last"));
        }

        http.Response.Headers[HeaderNames.Link] = string.Join(", ", links);
    }

    private static string Link(HttpRequest request, int number, string rel)
    {
        var query = request.Query
            .Where(pair => !string.Equals(pair.Key, "page", StringComparison.OrdinalIgnoreCase))
            .SelectMany(pair => pair.Value.Select(value => new KeyValuePair<string, string?>(pair.Key, value)))
            .Append(new KeyValuePair<string, string?>("page", number.ToString(CultureInfo.InvariantCulture)));
        return $"<{request.PathBase}{request.Path}{QueryString.Create(query)}>; rel=\"{rel}\"";
    }
}
