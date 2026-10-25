using AgentMate.ServerCore.Contracts;
using AgentMate.ServerCore.Updates;

namespace AgentMate.ServerCore.Tests.CoreUpdates;

/// <summary>
/// What a core update may ask for, and the script the switch runs as root. Nothing from a request
/// reaches the script that is not a release folder the app makes.
/// </summary>
public sealed class CoreUpdateRulesTests
{
    private const string Sha = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    private static CoreUpdateRequest Valid(string? url = "https://github.com/SmartClouds/AgentMate/releases/download/v1.2.0/agentmate-core-1.2.0-linux-x64.tar.gz") =>
        new("1.2.0", "agentmate-core-1.2.0-linux-x64.tar.gz", Sha, 40_000_000, url);

    [Fact]
    public void A_release_for_this_server_passes_with_or_without_an_address()
    {
        Assert.Null(CoreUpdateRules.Problem(Valid(), "linux-x64"));
        Assert.Null(CoreUpdateRules.Problem(Valid(url: null), "linux-x64"));
    }

    [Fact]
    public void Requests_that_do_not_name_a_release_for_this_server_are_refused()
    {
        Assert.NotNull(CoreUpdateRules.Problem(null, "linux-x64"));
        Assert.NotNull(CoreUpdateRules.Problem(Valid() with { Version = "1.2.0; rm -rf /" }, "linux-x64"));
        Assert.NotNull(CoreUpdateRules.Problem(Valid() with { File = "agentmate-core-1.2.0-linux-x64.tar.gz/../x" }, "linux-x64"));
        Assert.NotNull(CoreUpdateRules.Problem(Valid(), "linux-arm64"));
        Assert.NotNull(CoreUpdateRules.Problem(Valid() with { Sha256 = Sha.ToUpperInvariant() }, "linux-x64"));
        Assert.NotNull(CoreUpdateRules.Problem(Valid() with { Size = 0 }, "linux-x64"));
        Assert.NotNull(CoreUpdateRules.Problem(Valid() with { Size = CoreUpdateRules.MaxSize + 1 }, "linux-x64"));
    }

    [Theory]
    [InlineData("http://github.com/SmartClouds/AgentMate/releases/download/v1.2.0/agentmate-core-1.2.0-linux-x64.tar.gz")]
    [InlineData("https://example.com/SmartClouds/AgentMate/releases/download/v1.2.0/agentmate-core-1.2.0-linux-x64.tar.gz")]
    [InlineData("https://github.com/SmartClouds/AgentMate/releases/download/v1.2.0/agentmate-core-1.3.0-linux-x64.tar.gz")]
    [InlineData("https://github.com.evil.example/SmartClouds/AgentMate/releases/download/v1.2.0/agentmate-core-1.2.0-linux-x64.tar.gz")]
    public void Only_the_release_on_github_may_be_downloaded(string url) =>
        Assert.NotNull(CoreUpdateRules.Problem(Valid(url), "linux-x64"));

    [Fact]
    public void The_switch_script_names_the_two_releases_and_keeps_only_them()
    {
        var script = SystemdCoreInstallation.SwitchScript(
            "/opt/agentmate-core/releases/1.2.0-0123456789ab",
            "/opt/agentmate-core/releases/1.1.0-aaaaaaaaaaaa",
            "/opt/agentmate-core/update");

        Assert.Contains("new='/opt/agentmate-core/releases/1.2.0-0123456789ab'", script, StringComparison.Ordinal);
        Assert.Contains("old='/opt/agentmate-core/releases/1.1.0-aaaaaaaaaaaa'", script, StringComparison.Ordinal);
        Assert.Contains("'1.2.0-0123456789ab'|'1.1.0-aaaaaaaaaaaa')", script, StringComparison.Ordinal);
        Assert.Contains("systemctl restart agentmate-core && sleep 5 && systemctl is-active --quiet agentmate-core", script, StringComparison.Ordinal);
        Assert.Contains("systemctl reset-failed agentmate-core", script, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("/opt/agentmate-core/releases/1.2.0'; reboot; '", "/opt/agentmate-core/releases/1.1.0-aaaaaaaaaaaa")]
    [InlineData("/opt/agentmate-core/releases/1.2.0-0123456789ab", "/etc")]
    [InlineData("/opt/agentmate-core/releases/../../../etc", "/opt/agentmate-core/releases/1.1.0-aaaaaaaaaaaa")]
    public void The_switch_script_refuses_anything_but_release_folders(string release, string previous) =>
        Assert.Throws<ArgumentException>(() => SystemdCoreInstallation.SwitchScript(release, previous, "/opt/agentmate-core/update"));
}
