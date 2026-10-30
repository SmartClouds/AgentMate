using Runova.Website.Core.Releases;
using Runova.Website.Tests.Releases;

namespace Runova.Website.Tests.Mapping;

public class ReleaseMapperTests
{
    [Fact]
    public void A_release_has_the_contract_fields_and_its_assets()
    {
        var release = GitHubReleasesTests.ReadRecorded();
        release.GitHubETag = "W/\"abc\"";
        release.RowVersion = 12;

        var dto = ReleaseMapper.ToDto(release);

        Assert.Equal("2.2.0", dto.Version);
        Assert.Equal("v2.2.0", dto.TagName);
        Assert.Equal("Runova v2.2.0", dto.Name);
        Assert.Equal(release.PublishedAt, dto.PublishedAt);
        Assert.Equal(release.NotesUrl, dto.NotesUrl);
        Assert.Equal(release.FetchedAt, dto.FetchedAt);
        Assert.Equal(release.Assets.Select(a => a.Name), dto.Assets.Select(a => a.Name));
        var installer = Assert.Single(dto.Assets, a => a.Name == "Runova-Setup-2.2.0.exe");
        Assert.Equal(
            new ReleaseAssetDto(
                "Runova-Setup-2.2.0.exe", ReleasePlatform.Windows, ReleaseArch.X64, ReleaseKind.Nsis, 262371947,
                "9de6dc34acae92ac25fcc9099afb411190566f7f5a5734990b13ba88ca4fd879",
                "https://github.com/SmartClouds/Runova/releases/download/v2.2.0/Runova-Setup-2.2.0.exe"),
            installer);
    }

    [Fact]
    public void No_dto_carries_a_secret()
    {
        Assert.Empty(SecretProperties.In(typeof(ReleaseDto)));
        Assert.Empty(SecretProperties.In(typeof(ReleaseAssetDto)));
    }
}
