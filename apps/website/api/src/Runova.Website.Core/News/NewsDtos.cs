namespace Runova.Website.Core.News;

/// <summary>An affected technology as the contract shows it, with the technology's display name.</summary>
public sealed record AffectedTechnologyDto(string Technology, string Name, string VersionRange, string? FixedIn);

public sealed record SourceLinkDto(string Title, string Url);

/// <summary>
/// A news item in a list: the contract's <c>NewsListItemDto</c>. <c>publishedAt</c> is null only
/// for a draft, which only staff can list.
/// </summary>
public sealed record NewsListItemDto(
    long Id,
    string Slug,
    string Url,
    string Title,
    string Summary,
    NewsCategory Category,
    NewsSeverity Severity,
    IReadOnlyList<AffectedTechnologyDto> Technologies,
    IReadOnlyList<string> CveIds,
    decimal? CvssScore,
    IReadOnlyList<string> Tags,
    DateTimeOffset? PublishedAt,
    DateTimeOffset UpdatedAt);

/// <summary>A published news item on its own: the list fields, the rendered body and the sources.</summary>
public sealed record NewsItemDto(
    long Id,
    string Slug,
    string Url,
    string Title,
    string Summary,
    NewsCategory Category,
    NewsSeverity Severity,
    IReadOnlyList<AffectedTechnologyDto> Technologies,
    IReadOnlyList<string> CveIds,
    decimal? CvssScore,
    IReadOnlyList<string> Tags,
    DateTimeOffset PublishedAt,
    DateTimeOffset UpdatedAt,
    string BodyHtml,
    IReadOnlyList<SourceLinkDto> SourceLinks);

public sealed record TechnologyDto(string Slug, string Name, TechnologyKind Kind, bool Detectable);
