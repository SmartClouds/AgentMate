using System.Text.RegularExpressions;
using Runova.Website.Core.Media;
using Runova.Website.Core.News;

namespace Runova.Website.Core.Posts;

/// <summary>
/// A blog post. Runova.Website.Data maps it to the <c>Posts</c> table, with its tags through
/// <c>PostTags</c>; its full-text search vector is a generated column there, not a property here.
/// It goes through the same statuses as a news item.
/// </summary>
public class Post
{
    public long Id { get; set; }

    /// <summary>3 to 120 characters of a-z, 0-9 and single hyphens, with at least one letter.</summary>
    public string Slug { get; set; } = "";

    public string Title { get; set; } = "";

    public string Excerpt { get; set; } = "";

    public string BodyMarkdown { get; set; } = "";

    /// <summary>The body rendered and sanitized by <c>MarkdownRenderer</c> whenever it changes.</summary>
    public string BodyHtml { get; set; } = "";

    /// <summary>The body's word count over 230, rounded up, kept with the body.</summary>
    public int ReadingTimeMinutes { get; set; }

    public long? CoverMediaId { get; set; }

    public MediaFile? CoverMedia { get; set; }

    public List<Tag> Tags { get; set; } = [];

    /// <summary>The display name of the user or API client that wrote the post, as it was then.</summary>
    public string AuthorName { get; set; } = "";

    public NewsStatus Status { get; set; }

    /// <summary>When the post went or goes public; null for a draft that has no date yet.</summary>
    public DateTimeOffset? PublishedAt { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    /// <summary>One of <c>AuditActorKinds</c>: who wrote the post first.</summary>
    public string CreatedByKind { get; set; } = "user";

    /// <summary>The user or API client that wrote the post first; null for one made outside the API.</summary>
    public long? CreatedById { get; set; }

    public DateTimeOffset UpdatedAt { get; set; }

    /// <summary>PostgreSQL's <c>xmin</c>, the row version behind the ETag.</summary>
    public uint Version { get; set; }
}

/// <summary>A blog tag. Writers name tags freely; a name with a slug no tag has yet makes a new one.</summary>
public partial class Tag
{
    public long Id { get; set; }

    /// <summary>The name in lowercase with every run of other characters as one hyphen; unique.</summary>
    public string Slug { get; set; } = "";

    /// <summary>The name as the first post to use the tag wrote it.</summary>
    public string Name { get; set; } = "";

    public List<Post> Posts { get; set; } = [];

    /// <summary>The slug a tag name gets, empty when the name has no letter or digit.</summary>
    public static string SlugFor(string name) => NotSlug().Replace(name.ToLowerInvariant(), "-").Trim('-');

    [GeneratedRegex("[^a-z0-9]+")]
    private static partial Regex NotSlug();
}
