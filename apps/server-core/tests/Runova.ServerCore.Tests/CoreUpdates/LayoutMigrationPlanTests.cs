using Runova.ServerCore.Hosting;
using Runova.ServerCore.Updates;

namespace Runova.ServerCore.Tests.CoreUpdates;

/// <summary>
/// The scripts a layout migration runs as root. What they touch comes from the two layouts and
/// the release folder only, the old paths stay behind as links, and every step has an undo.
/// </summary>
public sealed class LayoutMigrationPlanTests
{
    private static readonly string _release = CoreLayout.Legacy.Releases + "/1.64.0-0123456789ab";

    private static LayoutMigrationStep Step(string name) =>
        LayoutMigrationPlan.Steps(_release).Single(step => step.Name == name);

    [Fact]
    public void The_steps_run_in_an_order_a_rollback_can_reverse()
    {
        Assert.Equal(
            ["release", "needrestart", "stop", "group", "data", "config", "selinux", "cutover", "runtime", "compat", "finish"],
            LayoutMigrationPlan.Steps(_release).Select(step => step.Name));
        Assert.All(LayoutMigrationPlan.Steps(_release), step =>
        {
            Assert.StartsWith("set -eu\n", step.Do, StringComparison.Ordinal);
            Assert.StartsWith("set -eu\n", step.Undo, StringComparison.Ordinal);
            Assert.NotEqual(step.Name, step.Description);
        });
    }

    [Fact]
    public void The_release_is_copied_to_the_same_name_in_the_new_folder()
    {
        Assert.Equal(CoreLayout.Runova.Releases + "/1.64.0-0123456789ab", LayoutMigrationPlan.NewReleaseFor(_release));
        var release = Step("release");

        Assert.Contains($"cp -a '{_release}' '{CoreLayout.Runova.Releases}/1.64.0-0123456789ab'.new", release.Do, StringComparison.Ordinal);
        Assert.Contains($"install -m 0644 -o root -g root '{CoreLayout.Runova.Releases}/1.64.0-0123456789ab'/runova-core.service /etc/systemd/system/runova-core.service", release.Do, StringComparison.Ordinal);
        Assert.Contains("rm -rf -- /opt/runova-core", release.Undo, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("/opt/runova-core/releases/1.64.0-0123456789ab")]
    [InlineData("/etc")]
    [InlineData("/opt/agentmate-core/releases/x'; reboot; '")] // legacy-name
    public void Only_a_legacy_release_folder_can_be_migrated(string release) =>
        Assert.Throws<ArgumentException>(() => LayoutMigrationPlan.Steps(release));

    [Theory]
    [InlineData("data")]
    [InlineData("config")]
    public void State_folders_move_and_leave_a_link_behind(string name)
    {
        var (from, to) = name == "data"
            ? (CoreLayout.Legacy.DataDirectory, CoreLayout.Runova.DataDirectory)
            : (CoreLayout.Legacy.ConfigDirectory, CoreLayout.Runova.ConfigDirectory);
        var step = Step(name);

        Assert.Contains($"mv -T {from} {to}", step.Do, StringComparison.Ordinal);
        Assert.Contains($"ln -s {to} {from}", step.Do, StringComparison.Ordinal);
        Assert.Contains($"rm -f {from}", step.Undo, StringComparison.Ordinal);
        Assert.Contains($"mv -T {to} {from}", step.Undo, StringComparison.Ordinal);
    }

    [Fact]
    public void The_group_is_renamed_so_its_id_and_members_stay()
    {
        Assert.Contains("groupmod -n runova agentmate", Step("group").Do, StringComparison.Ordinal); // legacy-name
        Assert.Contains("groupmod -n agentmate runova", Step("group").Undo, StringComparison.Ordinal); // legacy-name
    }

    [Fact]
    public void The_cutover_starts_the_new_unit_and_its_undo_brings_the_old_one_back()
    {
        var cutover = Step("cutover");
        Assert.Contains($"systemctl disable {CoreLayout.Legacy.Unit}", cutover.Do, StringComparison.Ordinal);
        Assert.Contains("systemctl start runova-core", cutover.Do, StringComparison.Ordinal);
        Assert.Contains("systemctl disable --now runova-core", cutover.Undo, StringComparison.Ordinal);
        Assert.Contains($"systemctl enable {CoreLayout.Legacy.Unit}", cutover.Undo, StringComparison.Ordinal);
        Assert.Contains($"systemctl start {CoreLayout.Legacy.Unit}", Step("stop").Undo, StringComparison.Ordinal);
    }

    [Fact]
    public void Old_apps_keep_finding_the_program_and_the_socket()
    {
        Assert.Contains($"ln -sfn {CoreLayout.Runova.CurrentLink} {CoreLayout.Legacy.Root}/current.new", Step("compat").Do, StringComparison.Ordinal);
        Assert.Contains($"ln -sfn '{_release}' {CoreLayout.Legacy.Root}/current.new", Step("compat").Undo, StringComparison.Ordinal);
        Assert.Contains($"L+ {CoreLayout.Legacy.RuntimeDirectory} - - - - {CoreLayout.Runova.RuntimeDirectory}", Step("runtime").Do, StringComparison.Ordinal);
        Assert.Contains(LayoutMigrationPlan.RuntimeLinkConfig, Step("runtime").Undo, StringComparison.Ordinal);
    }

    [Fact]
    public void The_old_unit_goes_last_and_comes_back_from_the_old_release()
    {
        Assert.Contains($"rm -f {CoreLayout.Legacy.UnitPath}", Step("finish").Do, StringComparison.Ordinal);
        Assert.Contains($"'{_release}'/{CoreLayout.Legacy.UnitFile} {CoreLayout.Legacy.UnitPath}", Step("finish").Undo, StringComparison.Ordinal);
    }

    [Fact]
    public void Needrestart_is_told_about_both_unit_names()
    {
        var step = Step("needrestart");
        Assert.Contains(CoreLayout.Runova.NeedrestartOverridePath, step.Do, StringComparison.Ordinal);
        Assert.Contains($"(?:runova-core|{CoreLayout.Legacy.Unit})", step.Do, StringComparison.Ordinal);
    }

    [Fact]
    public void The_preflight_only_reads()
    {
        var script = LayoutMigrationPlan.PreflightScript();
        Assert.Contains($"systemctl is-active --quiet {CoreLayout.Legacy.Unit}", script, StringComparison.Ordinal);
        Assert.Contains($"[ -e {CoreLayout.Runova.DataDirectory} ]", script, StringComparison.Ordinal);
        Assert.Contains($"mountpoint -q {CoreLayout.Legacy.DataDirectory}", script, StringComparison.Ordinal);
        Assert.DoesNotContain("mv ", script, StringComparison.Ordinal);
        Assert.DoesNotContain("rm ", script, StringComparison.Ordinal);
    }

    [Fact]
    public void Other_units_are_everything_but_the_cores_and_the_migration_itself()
    {
        const string listing = """
            agentmate-core.service loaded active running Core // legacy-name
            runova-migrate-0123456789abcdef0123456789abcdef.service loaded active running Move
            runova-migrate-0123456789abcdef0123456789abcdef.timer loaded active elapsed Move
            agentmate-fwrevert-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.timer loaded active waiting Revert // legacy-name
            agentmate-coreupdate-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.timer loaded active elapsed Switch // legacy-name
            """;

        Assert.Equal(
            ["agentmate-fwrevert-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.timer"], // legacy-name
            LayoutMigrationPlan.OtherUnits(listing, "runova-migrate-0123456789abcdef0123456789abcdef"));
    }

    [Fact]
    public void Both_transient_unit_prefixes_are_listed() =>
        Assert.Equal(["runova-*", $"{CoreLayout.TransientUnitPrefixes[1]}*"], LayoutMigrationPlan.ActiveUnits().Arguments.TakeLast(2));
}
