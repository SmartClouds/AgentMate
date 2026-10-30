using Riok.Mapperly.Abstractions;
using Runova.Website.Core.Media;
using Runova.Website.Core.News;

namespace Runova.Website.Core.Posts;

/// <summary>
/// The caller passes the post's public URL and its cover image, whose URL comes from the site's
/// configured origin too (null for a post with none).
/// </summary>
[Mapper]
public static partial class PostMapper
{
    [MapPropertyFromSource(nameof(PostListItemDto.Author), Use = nameof(Author))]
    public static partial PostListItemDto ToListItemDto(Post post, string url, CoverImageDto? coverImage);

    /// <summary>For a published post only: one with no <c>publishedAt</c> throws.</summary>
    [MapPropertyFromSource(nameof(PostDto.Author), Use = nameof(Author))]
    public static partial PostDto ToDto(Post post, string url, CoverImageDto? coverImage);

    /// <summary>The creator lives in another table, so the caller passes it too (null for a post made outside the API).</summary>
    [MapPropertyFromSource(nameof(PostAdminDto.Author), Use = nameof(Author))]
    public static partial PostAdminDto ToAdminDto(Post post, string url, CoverImageDto? coverImage, NewsCreatorDto? createdBy);

    private static partial PostTagDto ToDto(Tag tag);

    private static PostAuthorDto Author(Post post) => new(post.AuthorName);
}
