namespace Runova.Website.Core.Releases;

/// <summary>What a desktop asset is: the platform it installs on, its architecture and kind.</summary>
public sealed record DesktopAssetType(ReleasePlatform Platform, ReleaseArch Arch, ReleaseKind Kind);

/// <summary>
/// Tells the desktop app's files in a release from everything else, by the names
/// apps/desktop/electron-builder.yml gives them, and picks the one a platform should download.
/// </summary>
public static class DesktopAssets
{
    // The contract's table; {v} is the version.
    private static readonly (string Pattern, DesktopAssetType Type)[] _names =
    [
        ("Runova-Setup-{v}.exe", new(ReleasePlatform.Windows, ReleaseArch.X64, ReleaseKind.Nsis)),
        ("Runova-{v}.dmg", new(ReleasePlatform.Macos, ReleaseArch.X64, ReleaseKind.Dmg)),
        ("Runova-{v}-arm64.dmg", new(ReleasePlatform.Macos, ReleaseArch.Arm64, ReleaseKind.Dmg)),
        ("Runova-{v}-universal.dmg", new(ReleasePlatform.Macos, ReleaseArch.Universal, ReleaseKind.Dmg)),
        ("Runova-{v}-mac.zip", new(ReleasePlatform.Macos, ReleaseArch.X64, ReleaseKind.Zip)),
        ("Runova-{v}-arm64-mac.zip", new(ReleasePlatform.Macos, ReleaseArch.Arm64, ReleaseKind.Zip)),
        ("Runova-{v}.AppImage", new(ReleasePlatform.Linux, ReleaseArch.X64, ReleaseKind.Appimage)),
        ("Runova-{v}-arm64.AppImage", new(ReleasePlatform.Linux, ReleaseArch.Arm64, ReleaseKind.Appimage)),
        ("Runova-{v}-amd64.deb", new(ReleasePlatform.Linux, ReleaseArch.X64, ReleaseKind.Deb)),
        ("Runova-{v}-arm64.deb", new(ReleasePlatform.Linux, ReleaseArch.Arm64, ReleaseKind.Deb)),
    ];

    /// <summary>
    /// The type of a file of the release with this version, or null for anything that is not the
    /// desktop app: updater metadata, blockmaps, server core archives, checksums, plugins, another
    /// version's files.
    /// </summary>
    public static DesktopAssetType? Classify(string name, string version)
    {
        foreach (var (pattern, type) in _names)
        {
            if (string.Equals(name, pattern.Replace("{v}", version, StringComparison.Ordinal), StringComparison.Ordinal))
            {
                return type;
            }
        }

        return null;
    }

    /// <summary>
    /// The file to send someone who downloads for a platform: Windows gets the x64 installer, macOS
    /// a dmg, Linux an AppImage, unless <paramref name="kind"/> asks for another kind. On macOS
    /// with no arch asked, arm64 comes first, then universal, then x64; an asked arch falls back
    /// only to universal, which runs on it. Elsewhere the arch is the asked one, x64 by default.
    /// </summary>
    public static ReleaseAsset? Best(IEnumerable<ReleaseAsset> assets, ReleasePlatform platform, ReleaseArch? arch, ReleaseKind? kind)
    {
        var wanted = kind ?? DefaultKind(platform);
        var candidates = assets.Where(a => a.Platform == platform && a.Kind == wanted).ToList();
        return ArchesFor(platform, arch)
            .Select(a => candidates.FirstOrDefault(c => c.Arch == a))
            .FirstOrDefault(c => c is not null);
    }

    private static ReleaseKind DefaultKind(ReleasePlatform platform) => platform switch
    {
        ReleasePlatform.Windows => ReleaseKind.Nsis,
        ReleasePlatform.Macos => ReleaseKind.Dmg,
        _ => ReleaseKind.Appimage,
    };

    private static ReleaseArch[] ArchesFor(ReleasePlatform platform, ReleaseArch? arch) => (platform, arch) switch
    {
        (ReleasePlatform.Macos, null) => [ReleaseArch.Arm64, ReleaseArch.Universal, ReleaseArch.X64],
        (ReleasePlatform.Macos, ReleaseArch.Universal) => [ReleaseArch.Universal],
        (ReleasePlatform.Macos, { } asked) => [asked, ReleaseArch.Universal],
        _ => [arch ?? ReleaseArch.X64],
    };
}
