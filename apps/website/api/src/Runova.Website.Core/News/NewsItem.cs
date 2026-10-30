namespace Runova.Website.Core.News;

/// <summary>
/// A piece of technology news. Runova.Website.Data maps it to the <c>NewsItems</c> table; its
/// full-text search vector is a generated column there, not a property here.
/// </summary>
public class NewsItem
{
    public long Id { get; set; }

    /// <summary>3 to 120 characters of a-z, 0-9 and single hyphens, with at least one letter.</summary>
    public string Slug { get; set; } = "";

    public string Title { get; set; } = "";

    public string Summary { get; set; } = "";

    public string BodyMarkdown { get; set; } = "";

    /// <summary>The body rendered and sanitized by <c>MarkdownRenderer</c> whenever it changes.</summary>
    public string BodyHtml { get; set; } = "";

    public NewsCategory Category { get; set; }

    public NewsSeverity Severity { get; set; }

    public List<AffectedTechnology> Technologies { get; set; } = [];

    public List<string> CveIds { get; set; } = [];

    /// <summary>0.0 to 10.0 with one decimal, when the item has one.</summary>
    public decimal? CvssScore { get; set; }

    public List<SourceLink> SourceLinks { get; set; } = [];

    public List<string> Tags { get; set; } = [];

    public NewsStatus Status { get; set; }

    /// <summary>When the item went or goes public; null for a draft that has no date yet.</summary>
    public DateTimeOffset? PublishedAt { get; set; }

    public DateTimeOffset UpdatedAt { get; set; }

    /// <summary>PostgreSQL's <c>xmin</c>, the row version behind the ETag.</summary>
    public uint Version { get; set; }
}

/// <summary>A technology a news item affects, and which of its versions.</summary>
public class AffectedTechnology
{
    /// <summary>A slug from <see cref="Technologies"/>.</summary>
    public string Technology { get; set; } = "";

    /// <summary>A range in the contract's grammar, such as <c>&gt;=9.8.0 &lt;10.3.0</c>.</summary>
    public string VersionRange { get; set; } = "";

    /// <summary>The first version that is not affected, when there is one.</summary>
    public string? FixedIn { get; set; }
}

public class SourceLink
{
    public string Title { get; set; } = "";

    public string Url { get; set; } = "";
}
