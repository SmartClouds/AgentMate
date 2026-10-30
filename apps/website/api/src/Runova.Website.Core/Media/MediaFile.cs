using Riok.Mapperly.Abstractions;

namespace Runova.Website.Core.Media;

/// <summary>An uploaded image, stored in the media folder under <see cref="Path"/> and served at <c>/media/</c> plus it.</summary>
public class MediaFile
{
    public long Id { get; set; }

    /// <summary><c>yyyy/mm/random.ext</c>, relative to the media folder.</summary>
    public string Path { get; set; } = "";

    public string ContentType { get; set; } = "";

    public int Width { get; set; }

    public int Height { get; set; }

    /// <summary>The stored file's size in bytes, after re-encoding.</summary>
    public long Size { get; set; }

    public string Alt { get; set; } = "";

    public DateTimeOffset CreatedAt { get; set; }

    /// <summary>One of <c>AuditActorKinds</c>: who uploaded it.</summary>
    public string CreatedByKind { get; set; } = "user";

    public long? CreatedById { get; set; }
}

public sealed record MediaDto(long Id, string Url, string ContentType, int Width, int Height, long Size, string Alt, DateTimeOffset CreatedAt);

/// <summary>A post's cover image as the post shows it.</summary>
public sealed record CoverImageDto(string Url, int Width, int Height, string Alt);

/// <summary>The caller passes the file's public URL, which comes from the site's configured origin.</summary>
[Mapper]
public static partial class MediaMapper
{
    public static partial MediaDto ToDto(MediaFile file, string url);

    public static partial CoverImageDto ToCoverImageDto(MediaFile file, string url);
}
