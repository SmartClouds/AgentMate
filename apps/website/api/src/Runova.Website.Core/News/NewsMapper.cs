using Riok.Mapperly.Abstractions;

namespace Runova.Website.Core.News;

[Mapper]
public static partial class NewsMapper
{
    /// <summary>The caller passes the item's public URL, which comes from the site's configured origin.</summary>
    public static partial NewsListItemDto ToListItemDto(NewsItem item, string url);

    /// <summary>For a published item only: one with no <c>publishedAt</c> throws.</summary>
    public static partial NewsItemDto ToDto(NewsItem item, string url);

    /// <summary>
    /// The caller passes the item's public URL and its creator, which lives in another table
    /// (null for an item made outside the API).
    /// </summary>
    public static partial NewsItemAdminDto ToAdminDto(NewsItem item, string url, NewsCreatorDto? createdBy);

    [MapPropertyFromSource(nameof(AffectedTechnologyDto.Name), Use = nameof(TechnologyName))]
    private static partial AffectedTechnologyDto ToDto(AffectedTechnology technology);

    private static partial SourceLinkDto ToDto(SourceLink link);

    // Every stored slug is on the list (a foreign key sees to it); the slug stands in should one not be.
    private static string TechnologyName(AffectedTechnology technology) =>
        Technologies.Find(technology.Technology)?.Name ?? technology.Technology;
}

[Mapper]
public static partial class TechnologyMapper
{
    public static partial TechnologyDto ToDto(Technology technology);
}
