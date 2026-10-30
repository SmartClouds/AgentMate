using System.Globalization;
using Runova.Website.Core.Paging;

namespace Runova.Website.Core.News;

/// <summary>The query parameters of <c>GET /api/v1/news</c> as they came in, before any check.</summary>
public sealed record NewsListParameters(
    string[]? Category = null,
    string[]? Severity = null,
    string? MinSeverity = null,
    string[]? Technology = null,
    string[]? Tag = null,
    string? Since = null,
    string? Q = null,
    string? Sort = null,
    string[]? Status = null,
    int? Page = null,
    int? PageSize = null);

/// <summary>
/// A checked news list query. Different parameters combine with AND and the values of one
/// parameter with OR; an empty list filters nothing. No <see cref="Statuses"/> means the public
/// view: published items whose time has come.
/// </summary>
public sealed record NewsListQuery(
    IReadOnlyList<NewsCategory> Categories,
    IReadOnlyList<NewsSeverity> Severities,
    NewsSeverity? MinSeverity,
    IReadOnlyList<string> Technologies,
    IReadOnlyList<string> Tags,
    DateTimeOffset? Since,
    string? Search,
    NewsSort Sort,
    IReadOnlyList<NewsStatus> Statuses,
    PageRequest Page)
{
    public const int MinSearch = 2;
    public const int MaxSearch = 100;

    private static readonly Dictionary<string, NewsSort> _sorts = new(StringComparer.Ordinal)
    {
        ["-publishedAt"] = NewsSort.Newest,
        ["publishedAt"] = NewsSort.Oldest,
        ["-severity"] = NewsSort.Severity,
    };

    /// <summary>
    /// Every value out of range or unknown is named in <paramref name="errors"/> by its query
    /// parameter, all at once, and the query that comes back must then not be used.
    /// </summary>
    public static NewsListQuery Parse(NewsListParameters parameters, out Dictionary<string, string[]> errors)
    {
        var page = PageRequest.Parse(parameters.Page, parameters.PageSize, out errors);
        var found = errors;

        var categories = ParseAll<NewsCategory>(parameters.Category, "category");
        var severities = ParseAll<NewsSeverity>(parameters.Severity, "severity");
        var statuses = ParseAll<NewsStatus>(parameters.Status, "status");

        NewsSeverity? minSeverity = null;
        if (parameters.MinSeverity is { } min)
        {
            if (ApiEnums.TryParse<NewsSeverity>(min, out var level))
            {
                minSeverity = level;
            }
            else
            {
                found["minSeverity"] = [$"Unknown severity '{min}'."];
            }
        }

        var technologies = Distinct(parameters.Technology);
        var unknown = technologies.Where(slug => News.Technologies.Find(slug) is null).ToList();
        if (unknown.Count > 0)
        {
            found["technology"] = [.. unknown.Select(slug => $"Unknown technology slug '{slug}'.")];
        }

        DateTimeOffset? since = null;
        if (parameters.Since is { } sinceText)
        {
            if (DateTimeOffset.TryParse(sinceText, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var time))
            {
                since = time.ToUniversalTime();
            }
            else
            {
                found["since"] = ["since is an RFC 3339 time, such as 2026-10-30T12:00:00.000Z."];
            }
        }

        var search = string.IsNullOrWhiteSpace(parameters.Q) ? null : parameters.Q.Trim();
        if (search is { Length: < MinSearch or > MaxSearch })
        {
            found["q"] = [$"q is {MinSearch} to {MaxSearch} characters."];
        }

        var sort = NewsSort.Newest;
        if (parameters.Sort is { } sortText && !_sorts.TryGetValue(sortText, out sort))
        {
            found["sort"] = ["sort is -publishedAt, publishedAt or -severity."];
        }

        return new NewsListQuery(categories, severities, minSeverity, technologies, Distinct(parameters.Tag), since, search, sort, statuses, page);

        List<T> ParseAll<T>(string[]? values, string parameter)
            where T : struct, Enum
        {
            var parsed = new List<T>();
            foreach (var value in Distinct(values))
            {
                if (ApiEnums.TryParse<T>(value, out var item))
                {
                    parsed.Add(item);
                }
                else
                {
                    found[parameter] = [.. found.GetValueOrDefault(parameter) ?? [], $"Unknown {parameter} '{value}'."];
                }
            }

            return parsed;
        }
    }

    private static List<string> Distinct(string[]? values) => [.. (values ?? []).Distinct(StringComparer.Ordinal)];
}
