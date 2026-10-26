using Runova.ServerCore.Contracts;
using Runova.ServerCore.Hosting;
using Runova.ServerCore.Updates;

namespace Runova.ServerCore.Tests.CoreUpdates;

/// <summary>
/// What a core update may ask for, and the script the switch runs as root. Nothing from a request
/// reaches the script that is not a release folder the app makes.
/// </summary>
public sealed class CoreUpdateRulesTests
{
    private const string Sha = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    private static readonly CoreLayout _runova = CoreLayout.Runova;

    private static CoreUpdateRequest Valid(string? url = "https://github.com/SmartClouds/Runova/releases/download/v1.72.0/runova-core-1.72.0-linux-x64.tar.gz") =>
        new("1.72.0", "runova-core-1.72.0-linux-x64.tar.gz", Sha, 40_000_000, url);

    [Fact]
    public void A_release_for_this_server_passes_with_or_without_an_address()
    {
        Assert.Null(CoreUpdateRules.Problem(Valid(), "linux-x64", _runova));
        Assert.Null(CoreUpdateRules.Problem(Valid(url: null), "linux-x64", _runova));
    }

    [Fact]
    public void Requests_that_do_not_name_a_release_for_this_server_are_refused()
    {
        Assert.NotNull(CoreUpdateRules.Problem(null, "linux-x64", _runova));
        Assert.NotNull(CoreUpdateRules.Problem(Valid() with { Version = "1.72.0; rm -rf /" }, "linux-x64", _runova));
        Assert.NotNull(CoreUpdateRules.Problem(Valid() with { File = "runova-core-1.72.0-linux-x64.tar.gz/../x" }, "linux-x64", _runova));
        Assert.NotNull(CoreUpdateRules.Problem(Valid(), "linux-arm64", _runova));
        Assert.NotNull(CoreUpdateRules.Problem(Valid() with { Sha256 = Sha.ToUpperInvariant() }, "linux-x64", _runova));
        Assert.NotNull(CoreUpdateRules.Problem(Valid() with { Size = 0 }, "linux-x64", _runova));
        Assert.NotNull(CoreUpdateRules.Problem(Valid() with { Size = CoreUpdateRules.MaxSize + 1 }, "linux-x64", _runova));
    }

    [Theory]
    [InlineData("http://github.com/SmartClouds/Runova/releases/download/v1.72.0/runova-core-1.72.0-linux-x64.tar.gz")]
    [InlineData("https://example.com/SmartClouds/Runova/releases/download/v1.72.0/runova-core-1.72.0-linux-x64.tar.gz")]
    [InlineData("https://github.com/SmartClouds/Runova/releases/download/v1.72.0/runova-core-1.73.0-linux-x64.tar.gz")]
    [InlineData("https://github.com.evil.example/SmartClouds/Runova/releases/download/v1.72.0/runova-core-1.72.0-linux-x64.tar.gz")]
    public void Only_the_release_on_github_may_be_downloaded(string url) =>
        Assert.NotNull(CoreUpdateRules.Problem(Valid(url), "linux-x64", _runova));

    [Fact]
    public void The_switch_script_names_the_two_releases_and_keeps_only_them()
    {
        var script = SystemdCoreInstallation.SwitchScript(
            "/opt/runova-core/releases/1.72.0-0123456789ab",
            "/opt/runova-core/releases/1.71.0-aaaaaaaaaaaa",
            "/opt/runova-core/update", _runova);

        Assert.Contains("new='/opt/runova-core/releases/1.72.0-0123456789ab'", script, StringComparison.Ordinal);
        Assert.Contains("old='/opt/runova-core/releases/1.71.0-aaaaaaaaaaaa'", script, StringComparison.Ordinal);
        Assert.Contains("'1.72.0-0123456789ab'|'1.71.0-aaaaaaaaaaaa')", script, StringComparison.Ordinal);
        Assert.Contains("systemctl restart runova-core && sleep 5 && systemctl is-active --quiet runova-core", script, StringComparison.Ordinal);
        Assert.Contains("systemctl reset-failed runova-core", script, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("/opt/runova-core/releases/1.72.0'; reboot; '", "/opt/runova-core/releases/1.71.0-aaaaaaaaaaaa")]
    [InlineData("/opt/runova-core/releases/1.72.0-0123456789ab", "/etc")]
    [InlineData("/opt/runova-core/releases/../../../etc", "/opt/runova-core/releases/1.71.0-aaaaaaaaaaaa")]
    public void The_switch_script_refuses_anything_but_release_folders(string release, string previous) =>
        Assert.Throws<ArgumentException>(() => SystemdCoreInstallation.SwitchScript(release, previous, "/opt/runova-core/update", _runova));
}
