using Runova.Website.Core;
using Runova.Website.Core.Releases;

namespace Runova.Website.Tests.Releases;

public class DesktopAssetsTests
{
    private const string Version = "2.2.0";

    /// <summary>
    /// What each file of the recorded v2.2.0 release is: a desktop asset as platform, arch and kind,
    /// or null for everything that is not the desktop app.
    /// </summary>
    private static readonly Dictionary<string, (ReleasePlatform, ReleaseArch, ReleaseKind)?> _recorded = new()
    {
        ["Runova-Setup-2.2.0.exe"] = (ReleasePlatform.Windows, ReleaseArch.X64, ReleaseKind.Nsis),
        ["Runova-2.2.0.dmg"] = (ReleasePlatform.Macos, ReleaseArch.X64, ReleaseKind.Dmg),
        ["Runova-2.2.0-arm64.dmg"] = (ReleasePlatform.Macos, ReleaseArch.Arm64, ReleaseKind.Dmg),
        ["Runova-2.2.0-mac.zip"] = (ReleasePlatform.Macos, ReleaseArch.X64, ReleaseKind.Zip),
        ["Runova-2.2.0-arm64-mac.zip"] = (ReleasePlatform.Macos, ReleaseArch.Arm64, ReleaseKind.Zip),
        ["Runova-2.2.0.AppImage"] = (ReleasePlatform.Linux, ReleaseArch.X64, ReleaseKind.Appimage),
        ["Runova-2.2.0-amd64.deb"] = (ReleasePlatform.Linux, ReleaseArch.X64, ReleaseKind.Deb),
        // Updater metadata and blockmaps.
        ["latest.yml"] = null,
        ["latest-mac.yml"] = null,
        ["latest-linux.yml"] = null,
        ["Runova-Setup-2.2.0.exe.blockmap"] = null,
        ["Runova-2.2.0.dmg.blockmap"] = null,
        ["Runova-2.2.0-arm64.dmg.blockmap"] = null,
        // Server core archives, their checksums, the manifest and the connector plugins.
        ["runova-core-2.2.0-linux-x64.tar.gz"] = null,
        ["runova-core-2.2.0-linux-x64.tar.gz.sha256"] = null,
        ["runova-core-2.2.0-linux-arm64.tar.gz"] = null,
        ["runova-core-2.2.0-linux-arm64.tar.gz.sha256"] = null,
        ["agentmate-core-2.2.0-linux-x64.tar.gz"] = null,
        ["agentmate-core-2.2.0-linux-x64.tar.gz.sha256"] = null,
        ["agentmate-core-2.2.0-linux-arm64.tar.gz"] = null,
        ["agentmate-core-2.2.0-linux-arm64.tar.gz.sha256"] = null,
        ["server-core-manifest.json"] = null,
        ["runova-connector.zip"] = null,
        ["agentmate-connector.zip"] = null,
        // The Android app.
        ["Runova-2.2.0.apk"] = null,
        ["Runova-2.2.0-arm64-v8a.apk"] = null,
        ["Runova-2.2.0-armeabi-v7a.apk"] = null,
        ["Runova-2.2.0-x86.apk"] = null,
        ["Runova-2.2.0-x86_64.apk"] = null,
    };

    [Fact]
    public void Every_asset_of_the_recorded_release_is_classified()
    {
        var names = GitHubReleasesTests.RecordedAssetNames();

        Assert.Equal(_recorded.Keys.Order(StringComparer.Ordinal), names.Order(StringComparer.Ordinal));
        Assert.All(names, name =>
        {
            var expected = _recorded[name];
            var actual = DesktopAssets.Classify(name, Version);
            Assert.Equal(expected, actual is null ? null : (actual.Platform, actual.Arch, actual.Kind));
        });
    }

    [Theory]
    [InlineData("Runova-Setup-2.2.0.exe", ReleasePlatform.Windows, ReleaseArch.X64, ReleaseKind.Nsis)]
    [InlineData("Runova-2.2.0.dmg", ReleasePlatform.Macos, ReleaseArch.X64, ReleaseKind.Dmg)]
    [InlineData("Runova-2.2.0-arm64.dmg", ReleasePlatform.Macos, ReleaseArch.Arm64, ReleaseKind.Dmg)]
    [InlineData("Runova-2.2.0-universal.dmg", ReleasePlatform.Macos, ReleaseArch.Universal, ReleaseKind.Dmg)]
    [InlineData("Runova-2.2.0-mac.zip", ReleasePlatform.Macos, ReleaseArch.X64, ReleaseKind.Zip)]
    [InlineData("Runova-2.2.0-arm64-mac.zip", ReleasePlatform.Macos, ReleaseArch.Arm64, ReleaseKind.Zip)]
    [InlineData("Runova-2.2.0.AppImage", ReleasePlatform.Linux, ReleaseArch.X64, ReleaseKind.Appimage)]
    [InlineData("Runova-2.2.0-arm64.AppImage", ReleasePlatform.Linux, ReleaseArch.Arm64, ReleaseKind.Appimage)]
    [InlineData("Runova-2.2.0-amd64.deb", ReleasePlatform.Linux, ReleaseArch.X64, ReleaseKind.Deb)]
    [InlineData("Runova-2.2.0-arm64.deb", ReleasePlatform.Linux, ReleaseArch.Arm64, ReleaseKind.Deb)]
    public void Each_name_of_the_contract_table_is_a_desktop_asset(string name, ReleasePlatform platform, ReleaseArch arch, ReleaseKind kind)
    {
        Assert.Equal(new DesktopAssetType(platform, arch, kind), DesktopAssets.Classify(name, Version));
    }

    [Theory]
    [InlineData("Runova-Setup-2.1.0.exe")]
    [InlineData("runova-setup-2.2.0.exe")]
    [InlineData("Runova-Setup-2.2.0.exe.blockmap")]
    [InlineData("Runova-2.2.0-x64.dmg")]
    [InlineData("Runova-2.2.0.deb")]
    [InlineData("Runova Setup 2.2.0.exe")]
    [InlineData("Runova-Setup-2.2.0.exe ")]
    [InlineData("")]
    public void A_name_outside_the_table_or_of_another_version_is_left_out(string name)
    {
        Assert.Null(DesktopAssets.Classify(name, Version));
    }

    [Fact]
    public void Platforms_architectures_and_kinds_are_the_contract_strings()
    {
        Assert.Equal(["windows", "macos", "linux"], Enum.GetValues<ReleasePlatform>().Select(ApiEnums.Name));
        Assert.Equal(["x64", "arm64", "universal"], Enum.GetValues<ReleaseArch>().Select(ApiEnums.Name));
        Assert.Equal(["nsis", "dmg", "zip", "appimage", "deb"], Enum.GetValues<ReleaseKind>().Select(ApiEnums.Name));
    }

    [Theory]
    // Windows: the x64 installer.
    [InlineData(ReleasePlatform.Windows, null, null, "Runova-Setup-2.2.0.exe")]
    [InlineData(ReleasePlatform.Windows, ReleaseArch.X64, null, "Runova-Setup-2.2.0.exe")]
    [InlineData(ReleasePlatform.Windows, ReleaseArch.Arm64, null, null)]
    [InlineData(ReleasePlatform.Windows, null, ReleaseKind.Dmg, null)]
    // macOS: the dmg for the asked arch, else arm64, else universal, else x64.
    [InlineData(ReleasePlatform.Macos, null, null, "Runova-2.2.0-arm64.dmg")]
    [InlineData(ReleasePlatform.Macos, ReleaseArch.Arm64, null, "Runova-2.2.0-arm64.dmg")]
    [InlineData(ReleasePlatform.Macos, ReleaseArch.X64, null, "Runova-2.2.0.dmg")]
    [InlineData(ReleasePlatform.Macos, ReleaseArch.X64, ReleaseKind.Zip, "Runova-2.2.0-mac.zip")]
    [InlineData(ReleasePlatform.Macos, null, ReleaseKind.Zip, "Runova-2.2.0-arm64-mac.zip")]
    [InlineData(ReleasePlatform.Macos, ReleaseArch.Universal, null, null)]
    // Linux: the AppImage for the asked arch, x64 by default.
    [InlineData(ReleasePlatform.Linux, null, null, "Runova-2.2.0.AppImage")]
    [InlineData(ReleasePlatform.Linux, ReleaseArch.Arm64, null, null)]
    [InlineData(ReleasePlatform.Linux, null, ReleaseKind.Deb, "Runova-2.2.0-amd64.deb")]
    public void The_best_asset_follows_the_contract(ReleasePlatform platform, ReleaseArch? arch, ReleaseKind? kind, string? expected)
    {
        var release = GitHubReleasesTests.ReadRecorded();

        Assert.Equal(expected, DesktopAssets.Best(release.Assets, platform, arch, kind)?.Name);
    }

    [Fact]
    public void A_mac_with_no_arm64_dmg_gets_the_universal_one_before_the_x64_one()
    {
        var assets = new[] { Asset("Runova-2.2.0.dmg"), Asset("Runova-2.2.0-universal.dmg") };

        Assert.Equal("Runova-2.2.0-universal.dmg", DesktopAssets.Best(assets, ReleasePlatform.Macos, null, null)?.Name);
        Assert.Equal("Runova-2.2.0-universal.dmg", DesktopAssets.Best(assets, ReleasePlatform.Macos, ReleaseArch.Arm64, null)?.Name);
        Assert.Equal("Runova-2.2.0.dmg", DesktopAssets.Best(assets, ReleasePlatform.Macos, ReleaseArch.X64, null)?.Name);
        Assert.Equal("Runova-2.2.0.dmg", DesktopAssets.Best([assets[0]], ReleasePlatform.Macos, null, null)?.Name);
    }

    private static ReleaseAsset Asset(string name)
    {
        var type = DesktopAssets.Classify(name, Version)!;
        return new ReleaseAsset { Name = name, Platform = type.Platform, Arch = type.Arch, Kind = type.Kind };
    }
}
