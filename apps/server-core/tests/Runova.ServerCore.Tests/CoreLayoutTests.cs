using Runova.ServerCore.Hosting;

namespace Runova.ServerCore.Tests;

/// <summary>
/// One binary runs in either layout and picks one from where it was started, so a server that
/// never migrates keeps working and a migrated one (old paths now links to the new) is never
/// taken for an old one.
/// </summary>
public sealed class CoreLayoutTests
{
    private static Func<string, bool> Existing(params string[] directories) => directories.Contains;

    [Theory]
    [InlineData("/opt/runova-core/releases/1.64.0-0123456789ab/runova-core")]
    // An old app runs the hard link through the old current link, which a migration points at the new folder.
    [InlineData("/opt/runova-core/releases/1.64.0-0123456789ab/agentmate-core")] // legacy-name
    public void A_core_started_from_the_new_folder_runs_in_the_runova_layout(string processPath) =>
        Assert.Same(CoreLayout.Runova, CoreLayout.Detect(processPath, Existing(CoreLayout.Legacy.DataDirectory)));

    [Theory]
    [InlineData("/opt/agentmate-core/releases/1.64.0-0123456789ab/agentmate-core")] // legacy-name
    [InlineData("/opt/agentmate-core/releases/1.64.0-0123456789ab/runova-core")] // legacy-name
    public void A_core_started_from_the_old_folder_runs_in_the_legacy_layout(string processPath) =>
        Assert.Same(CoreLayout.Legacy, CoreLayout.Detect(processPath, Existing(CoreLayout.Runova.DataDirectory)));

    [Fact]
    public void Anywhere_else_the_state_on_the_machine_decides()
    {
        const string build = "/home/dev/src/apps/server-core/bin/runova-core";

        Assert.Same(CoreLayout.Legacy, CoreLayout.Detect(build, Existing(CoreLayout.Legacy.DataDirectory)));
        Assert.Same(CoreLayout.Runova, CoreLayout.Detect(build, Existing(CoreLayout.Legacy.DataDirectory, CoreLayout.Runova.DataDirectory)));
        Assert.Same(CoreLayout.Runova, CoreLayout.Detect(build, Existing()));
        Assert.Same(CoreLayout.Runova, CoreLayout.Detect(null, Existing()));
    }

    [Fact]
    public void A_folder_that_only_starts_like_the_root_does_not_count()
    {
        Assert.Same(CoreLayout.Runova, CoreLayout.Detect("/opt/agentmate-core-old/runova-core", Existing())); // legacy-name
        Assert.Same(CoreLayout.Legacy, CoreLayout.Detect("/opt/runova-core2/runova-core", Existing(CoreLayout.Legacy.DataDirectory)));
    }

    [Fact]
    public void Each_layout_names_its_own_paths()
    {
        var runova = CoreLayout.Runova;
        Assert.Equal("/opt/runova-core/current/runova-core", runova.BinaryPath);
        Assert.Equal("/run/runova-core/core.sock", runova.SocketPath);
        Assert.Equal("/etc/runova-core/core.json", runova.ConfigFile);
        Assert.Equal("/etc/systemd/system/runova-core.service", runova.UnitPath);
        Assert.Equal("runova-core-1.64.0-linux-x64.tar.gz", runova.TarballName("1.64.0", "linux-x64"));
        Assert.Equal("runova", runova.Name);

        var legacy = CoreLayout.Legacy;
        Assert.Equal("/opt/agentmate-core/current/agentmate-core", legacy.BinaryPath); // legacy-name
        Assert.Equal("/run/agentmate-core/core.sock", legacy.SocketPath); // legacy-name
        Assert.Equal("/var/lib/agentmate-core", legacy.DataDirectory); // legacy-name
        Assert.Equal("agentmate", legacy.Group); // legacy-name
        Assert.Equal("agentmate-core-1.64.0-linux-x64.tar.gz", legacy.TarballName("1.64.0", "linux-x64")); // legacy-name
        Assert.Equal("legacy", legacy.Name);
        Assert.Same(runova, legacy.Other);
    }

    [Fact]
    public void Both_host_names_are_allowed() =>
        Assert.Equal(["runova-core", "agentmate-core"], CoreApplication.AllowedHosts.Take(2)); // legacy-name
}
