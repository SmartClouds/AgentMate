using Runova.Website.Core.News;
using Runova.Website.Core.Paging;

namespace Runova.Website.Core.Posts;

/// <summary>
/// A checked post list query: any of the tag slugs, a full-text search, and statuses for staff.
/// No <see cref="Statuses"/> means the public view: published posts whose time has come.
/// </summary>
public sealed record PostListQuery(IReadOnlyList<string> Tags, string? Search, IReadOnlyList<NewsStatus> Statuses, PageRequest Page)
{
    /// <summary>Every bad value is named in <paramref name="errors"/> by its query parameter, and the query must then not be used.</summary>
    public static PostListQuery Parse(string[]? tag, string? q, string[]? status, int? page, int? pageSize, out Dictionary<string, string[]> errors)
    {
        var paging = PageRequest.Parse(page, pageSize, out errors);

        var search = string.IsNullOrWhiteSpace(q) ? null : q.Trim();
        if (search is { Length: < NewsListQuery.MinSearch or > NewsListQuery.MaxSearch })
        {
            errors["q"] = [$"q is {NewsListQuery.MinSearch} to {NewsListQuery.MaxSearch} characters."];
        }

        var statuses = new List<NewsStatus>();
        foreach (var value in (status ?? []).Distinct(StringComparer.Ordinal))
        {
            if (ApiEnums.TryParse<NewsStatus>(value, out var parsed))
            {
                statuses.Add(parsed);
            }
            else
            {
                errors["status"] = [.. errors.GetValueOrDefault("status") ?? [], $"Unknown status '{value}'."];
            }
        }

        return new PostListQuery([.. (tag ?? []).Distinct(StringComparer.Ordinal)], search, statuses, paging);
    }
}
