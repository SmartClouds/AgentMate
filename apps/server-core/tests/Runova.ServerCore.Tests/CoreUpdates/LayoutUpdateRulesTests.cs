using Runova.ServerCore.Contracts;
using Runova.ServerCore.Hosting;
using Runova.ServerCore.Updates;

namespace Runova.ServerCore.Tests.CoreUpdates;

/// <summary>
/// Updates on either layout. A server still on the layout from before the rename takes a release
/// under either tarball name (old apps ask for the old one); a migrated server takes only the new
/// name, and never a release older than the first one that knows the new paths.
/// </summary>
public sealed class LayoutUpdateRulesTests
{
    private const string Sha = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    private static readonly string _legacyTarball = CoreLayout.Legacy.TarballName("1.72.0", "linux-x64");

    private static CoreUpdateRequest Request(string file, string version = "1.72.0", bool withUrl = true) =>
        new(version, file, Sha, 40_000_000, withUrl ? $"https://github.com/SmartClouds/Runova/releases/download/v{version}/{file}" : null);

    [Fact]
    public void The_legacy_layout_takes_a_release_under_either_name()
    {
        Assert.Null(CoreUpdateRules.Problem(Request("runova-core-1.72.0-linux-x64.tar.gz"), "linux-x64", CoreLayout.Legacy));
        Assert.Null(CoreUpdateRules.Problem(Request(_legacyTarball), "linux-x64", CoreLayout.Legacy));
    }

    [Fact]
    public void The_runova_layout_takes_only_the_new_name()
    {
        Assert.Null(CoreUpdateRules.Problem(Request("runova-core-1.72.0-linux-x64.tar.gz"), "linux-x64", CoreLayout.Runova));
        Assert.NotNull(CoreUpdateRules.Problem(Request(_legacyTarball), "linux-x64", CoreLayout.Runova));
    }

    [Fact]
    public void The_download_address_has_to_name_the_same_file()
    {
        var mixed = Request(_legacyTarball) with
        {
            DownloadUrl = "https://github.com/SmartClouds/Runova/releases/download/v1.72.0/runova-core-1.72.0-linux-x64.tar.gz",
        };

        Assert.NotNull(CoreUpdateRules.Problem(mixed, "linux-x64", CoreLayout.Legacy));
    }

    [Theory]
    [InlineData("1.63.0")]
    [InlineData("1.9.9")]
    [InlineData("0.0.0-dev")]
    public void A_migrated_server_never_goes_back_to_a_release_from_before_the_rename(string version)
    {
        var request = Request($"runova-core-{version}-linux-x64.tar.gz", version);

        Assert.Contains(CoreUpdateRules.FirstRunovaRelease, CoreUpdateRules.Problem(request, "linux-x64", CoreLayout.Runova), StringComparison.Ordinal);
        Assert.Null(CoreUpdateRules.Problem(request with { File = CoreLayout.Legacy.TarballName(version, "linux-x64"), DownloadUrl = null }, "linux-x64", CoreLayout.Legacy));
    }

    [Theory]
    [InlineData("1.64.0", false)]
    [InlineData("1.64.1", false)]
    [InlineData("1.100.0", false)]
    [InlineData("2.0.0", false)]
    [InlineData("1.63.9", true)]
    [InlineData("1.64.0-rc.1", false)]
    [InlineData("1.63", true)]
    [InlineData("nightly", true)]
    public void Versions_compare_by_their_numbers(string version, bool older) =>
        Assert.Equal(older, CoreUpdateRules.IsOlder(version, CoreUpdateRules.FirstRunovaRelease));

    [Fact]
    public void The_legacy_switch_script_restarts_the_legacy_unit_from_the_legacy_folder()
    {
        var legacy = CoreLayout.Legacy;
        var script = SystemdCoreInstallation.SwitchScript(
            legacy.Releases + "/1.72.0-0123456789ab",
            legacy.Releases + "/1.71.0-aaaaaaaaaaaa",
            legacy.Staging,
            legacy);

        Assert.Contains($"root={legacy.Root}", script, StringComparison.Ordinal);
        Assert.Contains($"unit={legacy.UnitPath}", script, StringComparison.Ordinal);
        Assert.Contains($"\"$1/{legacy.UnitFile}\"", script, StringComparison.Ordinal);
        Assert.Contains($"systemctl restart {legacy.Unit} && sleep 5 && systemctl is-active --quiet {legacy.Unit}", script, StringComparison.Ordinal);
        Assert.DoesNotContain(CoreLayout.Runova.Root, script, StringComparison.Ordinal);
    }

    [Fact]
    public void A_release_folder_belongs_to_one_layout()
    {
        Assert.True(SystemdCoreInstallation.IsReleasePath(CoreLayout.Legacy.Releases + "/1.72.0-0123456789ab", CoreLayout.Legacy));
        Assert.False(SystemdCoreInstallation.IsReleasePath(CoreLayout.Legacy.Releases + "/1.72.0-0123456789ab", CoreLayout.Runova));
        Assert.Throws<ArgumentException>(() => SystemdCoreInstallation.SwitchScript(
            CoreLayout.Runova.Releases + "/1.72.0-0123456789ab",
            CoreLayout.Runova.Releases + "/1.71.0-aaaaaaaaaaaa",
            CoreLayout.Runova.Staging,
            CoreLayout.Legacy));
    }
}
