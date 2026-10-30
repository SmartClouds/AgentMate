using Riok.Mapperly.Abstractions;

namespace Runova.Website.Core.Releases;

/// <summary>
/// A desktop release as read from GitHub Releases, with only its desktop assets. The newest
/// <see cref="FetchedAt"/> is the latest release.
/// </summary>
public class Release
{
    public long Id { get; set; }

    /// <summary>The tag without its leading <c>v</c>, as in <c>2.2.0</c>.</summary>
    public string Version { get; set; } = "";

    public string TagName { get; set; } = "";

    public string Name { get; set; } = "";

    public DateTimeOffset PublishedAt { get; set; }

    /// <summary>The release page on GitHub.</summary>
    public string NotesUrl { get; set; } = "";

    /// <summary>When GitHub last sent this release in full (a 304 does not change it).</summary>
    public DateTimeOffset FetchedAt { get; set; }

    /// <summary>GitHub's <c>ETag</c> for the response this came from, sent back as <c>If-None-Match</c>.</summary>
    public string? GitHubETag { get; set; }

    public List<ReleaseAsset> Assets { get; set; } = [];

    /// <summary>PostgreSQL's <c>xmin</c>, which the response's ETag is made from.</summary>
    public uint RowVersion { get; set; }
}

/// <summary>One desktop file of a release. Nothing else in a release is ever stored.</summary>
public class ReleaseAsset
{
    public string Name { get; set; } = "";

    public ReleasePlatform Platform { get; set; }

    public ReleaseArch Arch { get; set; }

    public ReleaseKind Kind { get; set; }

    public long Size { get; set; }

    /// <summary>Lowercase hex, or null when GitHub has no digest for the file.</summary>
    public string? Sha256 { get; set; }

    public string DownloadUrl { get; set; } = "";
}

public sealed record ReleaseAssetDto(
    string Name, ReleasePlatform Platform, ReleaseArch Arch, ReleaseKind Kind, long Size, string? Sha256, string DownloadUrl);

public sealed record ReleaseDto(
    string Version,
    string TagName,
    string Name,
    DateTimeOffset PublishedAt,
    string NotesUrl,
    DateTimeOffset FetchedAt,
    IReadOnlyList<ReleaseAssetDto> Assets);

[Mapper]
public static partial class ReleaseMapper
{
    public static partial ReleaseDto ToDto(Release release);

    public static partial ReleaseAssetDto ToDto(ReleaseAsset asset);
}
