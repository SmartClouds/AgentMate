using System.Text.Json;
using Runova.Website.Core.Releases;

namespace Runova.Website.Tests.Releases;

public class GitHubReleasesTests
{
    private static readonly DateTimeOffset _fetchedAt = new(2026, 10, 30, 11, 45, 0, TimeSpan.Zero);

    /// <summary><c>GET /repos/SmartClouds/Runova/releases/latest</c> as GitHub answered it for v2.2.0.</summary>
    public static string RecordedJson() =>
        File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Releases", "Fixtures", "github-release-v2.2.0.json"));

    public static IReadOnlyList<string> RecordedAssetNames()
    {
        using var document = JsonDocument.Parse(RecordedJson());
        return [.. document.RootElement.GetProperty("assets").EnumerateArray().Select(a => a.GetProperty("name").GetString()!)];
    }

    public static Release ReadRecorded() => GitHubReleases.Read(RecordedJson(), _fetchedAt);

    [Fact]
    public void The_recorded_release_is_read_with_its_version_and_links()
    {
        var release = ReadRecorded();

        Assert.Equal("2.2.0", release.Version);
        Assert.Equal("v2.2.0", release.TagName);
        Assert.Equal("Runova v2.2.0", release.Name);
        Assert.Equal(new DateTimeOffset(2026, 10, 30, 2, 18, 11, TimeSpan.Zero), release.PublishedAt);
        Assert.Equal("https://github.com/SmartClouds/Runova/releases/tag/v2.2.0", release.NotesUrl);
        Assert.Equal(_fetchedAt, release.FetchedAt);
    }

    [Fact]
    public void Only_the_desktop_assets_are_kept_with_size_checksum_and_download_url()
    {
        var release = ReadRecorded();

        Assert.Equal(
            [
                "Runova-2.2.0-amd64.deb", "Runova-2.2.0-arm64-mac.zip", "Runova-2.2.0-arm64.dmg", "Runova-2.2.0-mac.zip",
                "Runova-2.2.0.AppImage", "Runova-2.2.0.dmg", "Runova-Setup-2.2.0.exe",
            ],
            release.Assets.Select(a => a.Name).Order(StringComparer.Ordinal));
        var installer = Assert.Single(release.Assets, a => a.Name == "Runova-Setup-2.2.0.exe");
        Assert.Equal(ReleasePlatform.Windows, installer.Platform);
        Assert.Equal(ReleaseArch.X64, installer.Arch);
        Assert.Equal(ReleaseKind.Nsis, installer.Kind);
        Assert.Equal(262371947, installer.Size);
        Assert.Equal("9de6dc34acae92ac25fcc9099afb411190566f7f5a5734990b13ba88ca4fd879", installer.Sha256);
        Assert.Equal("https://github.com/SmartClouds/Runova/releases/download/v2.2.0/Runova-Setup-2.2.0.exe", installer.DownloadUrl);
    }

    [Theory]
    [InlineData("\"digest\": null,", null)]
    [InlineData("", null)]
    [InlineData("\"digest\": \"sha512:abcd\",", null)]
    [InlineData("\"digest\": \"sha256:ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef0123456789\",", "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789")]
    [InlineData("\"digest\": \"sha256:not-hex\",", null)]
    public void The_checksum_comes_from_a_sha256_digest_only(string digest, string? expected)
    {
        var release = GitHubReleases.Read(Json(Asset("Runova-Setup-1.0.0.exe", digest)), _fetchedAt);

        Assert.Equal(expected, Assert.Single(release.Assets).Sha256);
    }

    [Fact]
    public void An_asset_still_uploading_is_left_out()
    {
        var release = GitHubReleases.Read(
            Json(Asset("Runova-Setup-1.0.0.exe", state: "starter"), Asset("Runova-1.0.0.dmg")), _fetchedAt);

        Assert.Equal(["Runova-1.0.0.dmg"], release.Assets.Select(a => a.Name));
    }

    [Fact]
    public void A_release_with_no_name_is_named_after_its_tag()
    {
        var release = GitHubReleases.Read(Json("null", []), _fetchedAt);

        Assert.Equal("v1.0.0", release.Name);
        Assert.Equal("1.0.0", release.Version);
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("[]")]
    [InlineData("not json")]
    public void A_body_that_is_not_a_release_throws(string json)
    {
        Assert.ThrowsAny<JsonException>(() => GitHubReleases.Read(json, _fetchedAt));
    }

    private static string Json(params string[] assets) => Json("\"Runova 1.0.0\"", assets);

    private static string Json(string name, string[] assets) => $$"""
        {
          "tag_name": "v1.0.0",
          "name": {{name}},
          "published_at": "2026-10-01T00:00:00Z",
          "html_url": "https://github.com/SmartClouds/Runova/releases/tag/v1.0.0",
          "assets": [{{string.Join(",", assets)}}]
        }
        """;

    private static string Asset(string name, string digest = "", string state = "uploaded") => $$"""
        {
          "name": "{{name}}",
          "state": "{{state}}",
          "size": 10,
          {{digest}}
          "browser_download_url": "https://github.com/SmartClouds/Runova/releases/download/v1.0.0/{{name}}"
        }
        """;
}
