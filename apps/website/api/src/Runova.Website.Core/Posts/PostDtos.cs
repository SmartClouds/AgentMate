using Runova.Website.Core.Media;
using Runova.Website.Core.News;

namespace Runova.Website.Core.Posts;

public sealed record PostTagDto(string Slug, string Name);

public sealed record PostAuthorDto(string DisplayName);

/// <summary>A post in a list: the contract's <c>PostListItemDto</c>. <c>publishedAt</c> is null only for a draft.</summary>
public sealed record PostListItemDto(
    long Id,
    string Slug,
    string Url,
    string Title,
    string Excerpt,
    CoverImageDto? CoverImage,
    IReadOnlyList<PostTagDto> Tags,
    PostAuthorDto Author,
    DateTimeOffset? PublishedAt,
    DateTimeOffset UpdatedAt,
    int ReadingTimeMinutes);

/// <summary>A published post on its own: the list fields and the rendered body.</summary>
public sealed record PostDto(
    long Id,
    string Slug,
    string Url,
    string Title,
    string Excerpt,
    CoverImageDto? CoverImage,
    IReadOnlyList<PostTagDto> Tags,
    PostAuthorDto Author,
    DateTimeOffset PublishedAt,
    DateTimeOffset UpdatedAt,
    int ReadingTimeMinutes,
    string BodyHtml);

/// <summary>A post in any status, for staff and API clients: the public fields plus the Markdown, status, creator and version.</summary>
public sealed record PostAdminDto(
    long Id,
    string Slug,
    string Url,
    string Title,
    string Excerpt,
    CoverImageDto? CoverImage,
    IReadOnlyList<PostTagDto> Tags,
    PostAuthorDto Author,
    DateTimeOffset? PublishedAt,
    DateTimeOffset UpdatedAt,
    int ReadingTimeMinutes,
    string BodyHtml,
    string BodyMarkdown,
    NewsStatus Status,
    DateTimeOffset CreatedAt,
    NewsCreatorDto? CreatedBy,
    string Version);

/// <summary>A tag with the number of published posts that carry it.</summary>
public sealed record TagDto(string Slug, string Name, int PostCount);
