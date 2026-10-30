using System.Text.Json;
using System.Text.Json.Serialization;

namespace Runova.Website.Core.Releases;

/// <summary>Reads GitHub's REST answer for a release into a <see cref="Release"/> with only its desktop assets.</summary>
public static class GitHubReleases
{
    private const string Sha256Prefix = "sha256:";

    private static readonly JsonSerializerOptions _json = new() { PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower };

    /// <summary>
    /// Throws <see cref="JsonException"/> when the body is not a release. Files still uploading
    /// and files that are not the desktop app are left out.
    /// </summary>
    public static Release Read(string json, DateTimeOffset fetchedAt)
    {
        var release = JsonSerializer.Deserialize<GitHubRelease>(json, _json)
            ?? throw new JsonException("GitHub answered null for the release.");
        var version = release.TagName.StartsWith('v') ? release.TagName[1..] : release.TagName;
        return new Release
        {
            Version = version,
            TagName = release.TagName,
            Name = string.IsNullOrWhiteSpace(release.Name) ? release.TagName : release.Name,
            PublishedAt = release.PublishedAt,
            NotesUrl = release.HtmlUrl,
            FetchedAt = fetchedAt,
            Assets =
            [
                .. release.Assets
                    .Where(a => a.State is null or "uploaded")
                    .Select(a => (Asset: a, Type: DesktopAssets.Classify(a.Name, version)))
                    .Where(a => a.Type is not null)
                    .Select(a => new ReleaseAsset
                    {
                        Name = a.Asset.Name,
                        Platform = a.Type!.Platform,
                        Arch = a.Type.Arch,
                        Kind = a.Type.Kind,
                        Size = a.Asset.Size,
                        Sha256 = Sha256Of(a.Asset.Digest),
                        DownloadUrl = a.Asset.BrowserDownloadUrl,
                    }),
            ],
        };
    }

    // GitHub writes a digest as "<algorithm>:<hex>"; only a SHA-256 one is a checksum here.
    private static string? Sha256Of(string? digest)
    {
        if (digest is null || !digest.StartsWith(Sha256Prefix, StringComparison.Ordinal))
        {
            return null;
        }

        var hex = digest[Sha256Prefix.Length..];
        return hex.Length == 64 && hex.All(char.IsAsciiHexDigit) ? hex.ToLowerInvariant() : null;
    }

    private sealed record GitHubRelease(
        [property: JsonRequired] string TagName,
        string? Name,
        [property: JsonRequired] DateTimeOffset PublishedAt,
        [property: JsonRequired] string HtmlUrl,
        [property: JsonRequired] IReadOnlyList<GitHubAsset> Assets);

    private sealed record GitHubAsset(
        [property: JsonRequired] string Name,
        string? State,
        long Size,
        string? Digest,
        [property: JsonRequired] string BrowserDownloadUrl);
}
