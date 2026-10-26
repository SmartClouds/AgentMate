using System.Text;
using Microsoft.Extensions.Time.Testing;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Jobs;
using Runova.ServerCore.Platform;

namespace Runova.ServerCore.Tests;

/// <summary>
/// The Linux side of the platform layer on fixture servers from both families: the readers behind
/// metrics and system facts, services through systemctl, apt and dnf with the flags that keep them
/// from ever waiting for a person, and the reboot. Commands are checked argument by argument.
/// </summary>
public sealed class LinuxPlatformTests
{
    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private static readonly string[] _aptOptions =
    [
        "-q", "-y", "-o", "DPkg::Lock::Timeout=300", "-o", "Dpkg::Options::=--force-confdef", "-o", "Dpkg::Options::=--force-confold",
    ];

    private sealed class Stats(Dictionary<string, (long Total, long Free, long Available)> sizes) : IFileSystemStats
    {
        public (long Total, long Free, long Available)? Of(string mountPoint) =>
            sizes.TryGetValue(mountPoint, out var size) ? size : null;
    }

    private static readonly Stats _stats = new(new()
    {
        ["/"] = (100_000_000_000, 40_000_000_000, 35_000_000_000),
        ["/boot"] = (1_000_000_000, 800_000_000, 800_000_000),
        ["/boot/efi"] = (100_000_000, 90_000_000, 90_000_000),
    });

    [Theory]
    [InlineData("ubuntu-24.04", 8131468L * 1024)]
    [InlineData("rocky-9", 3735940L * 1024)]
    public void The_probe_reads_every_counter_of_a_server(string host, long memoryTotal)
    {
        var probe = new LinuxSystemProbe(new SystemFiles(Fixtures.Host(host)), _stats);

        var counters = probe.ReadCounters();

        Assert.True(counters.Cpu.Total > 0);
        Assert.Equal(memoryTotal, counters.Memory.TotalBytes);
        Assert.True(counters.Network.ReceivedBytes > 0);
        Assert.True(counters.Disk.ReadBytes > 0);
        Assert.True(counters.Load.One > 0);
    }

    [Fact]
    public void Filesystems_come_with_their_sizes_and_unreadable_ones_are_left_out()
    {
        var probe = new LinuxSystemProbe(new SystemFiles(Fixtures.Host("ubuntu-24.04")), _stats);

        var disks = probe.ReadFilesystems();

        var root = disks[0];
        Assert.Equal(new DiskInfo("/", "/dev/sda1", "ext4", 100_000_000_000, 60_000_000_000, 35_000_000_000), root);
        // /mnt/data volume has no size here (as if statvfs failed), so it is not shown.
        Assert.Equal(["/", "/boot", "/boot/efi"], disks.Select(d => d.MountPoint));
    }

    [Fact]
    public async Task System_facts_on_an_ubuntu_server()
    {
        using var root = new TestRoot("ubuntu-24.04");
        var processes = new FakeProcessRunner();
        processes.Respond("timedatectl", ["show"], _ => FakeProcessRunner.Ok(Fixtures.Read("timedatectl/show-synced.txt")));
        processes.Respond("systemctl", ["is-active"], _ => FakeProcessRunner.Exit(3, "inactive\ninactive\nactive\n"));
        var info = NewSystemInfo(root.Files, processes, Apt(root.Files, processes), new NetworkInterfaceInfo[]
        {
            new("eth0", Up: true, ["203.0.113.10", "10.0.0.5", "2a01:4f8:c17:1234::1"], "52:54:00:12:34:56", 1000),
            new("docker0", Up: true, ["172.17.0.1"]),
            new("veth4f2a1c9", Up: true, []),
        });

        var facts = await info.GetAsync(Cancel);

        Assert.Equal("web-01", facts.Hostname);
        Assert.Equal("6.8.0-45-generic", facts.Kernel);
        Assert.Equal("ubuntu", facts.Os.Id);
        Assert.Equal(OsFamily.Debian, facts.Os.Family);
        Assert.Equal("AMD EPYC 7B13", facts.Cpu.Model);
        Assert.Equal(8131468L * 1024, facts.MemoryTotalBytes);
        Assert.Equal(2097148L * 1024, facts.SwapTotalBytes);
        Assert.Equal(1758370021000, facts.BootedAtUnixMs);
        Assert.Equal(["203.0.113.10", "2a01:4f8:c17:1234::1"], facts.PublicAddresses);
        Assert.Equal(["eth0"], facts.Networks.Select(n => n.Name));
        Assert.True(facts.RebootRequired);
        Assert.Equal(["linux-image-6.8.0-47-generic", "linux-base"], facts.RebootRequiredBy);
        Assert.Equal(new TimeSyncInfo(true, true, "Etc/UTC", "systemd-timesyncd"), facts.TimeSync);
        Assert.Equal("/", facts.Disks[0].MountPoint);
    }

    [Fact]
    public async Task System_facts_are_kept_a_little_while_so_callers_do_not_start_programs_each_time()
    {
        using var root = new TestRoot("ubuntu-24.04");
        var processes = new FakeProcessRunner();
        var clock = new FakeTimeProvider(DateTimeOffset.UtcNow);
        var info = NewSystemInfo(root.Files, processes, Apt(root.Files, processes), [], clock);

        await info.GetAsync(Cancel);
        var calls = processes.Calls.Count;
        await info.GetAsync(Cancel);
        clock.Advance(LinuxSystemInfo.CacheFor + TimeSpan.FromSeconds(1));
        await info.GetAsync(Cancel);

        Assert.True(calls > 0);
        Assert.Equal(calls * 2, processes.Calls.Count);
    }

    [Fact]
    public async Task Apt_lists_upgradable_packages_without_touching_the_system()
    {
        using var root = new TestRoot("ubuntu-24.04");
        var processes = new FakeProcessRunner();
        processes.Respond("apt", ["list", "--upgradable"], _ => new ProcessResult(
            0,
            Fixtures.Read("apt/list-upgradable-ubuntu-24.04.txt"),
            "WARNING: apt does not have a stable CLI interface. Use with caution in scripts.",
            false,
            false));

        var packages = await Apt(root.Files, processes).ListUpgradableAsync(Cancel);

        Assert.Equal(7, packages.Count);
        Assert.Equal(4, packages.Count(p => p.Security));
        var call = Assert.Single(processes.Calls);
        Assert.False(Units.IsUnitRun(call));
    }

    [Fact]
    public async Task Apt_upgrades_everything_without_ever_asking_a_question()
    {
        using var root = new TestRoot("ubuntu-24.04");
        root.Write("/etc/needrestart/conf.d/README", "drop-in files");
        var processes = new FakeProcessRunner();
        using var job = new TestJob();

        await Apt(root.Files, processes).UpgradeAsync(securityOnly: false, job.Context, Cancel);

        var units = processes.Calls.Where(Units.IsUnitRun).ToList();
        Assert.Equal(2, units.Count);
        Assert.Equal(["/usr/bin/apt-get", .. _aptOptions, "update"], Units.Command(units[0]));
        Assert.Equal(["/usr/bin/apt-get", .. _aptOptions, "--with-new-pkgs", "upgrade"], Units.Command(units[1]));
        Assert.Equal(job.Context.UnitFor("refresh"), Units.UnitName(units[0]));
        Assert.Equal(job.Context.UnitFor("upgrade"), Units.UnitName(units[1]));
        foreach (var unit in units)
        {
            Assert.Contains("DEBIAN_FRONTEND=noninteractive", Units.Environment(unit));
            Assert.Contains("NEEDRESTART_MODE=a", Units.Environment(unit));
            Assert.Contains("APT_LISTCHANGES_FRONTEND=none", Units.Environment(unit));
        }

        // needrestart may restart services at the end of the run; never the core that runs it.
        var keep = File.ReadAllText(root.Resolve("/etc/needrestart/conf.d/runova-core.conf"));
        Assert.Contains("runova-core", keep, StringComparison.Ordinal);
        Assert.Contains("override_rc", keep, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Apt_security_only_upgrades_exactly_what_the_security_pocket_carries()
    {
        using var root = new TestRoot("ubuntu-24.04");
        var processes = new FakeProcessRunner();
        processes.Respond("apt", ["list", "--upgradable"], _ => FakeProcessRunner.Ok(Fixtures.Read("apt/list-upgradable-ubuntu-24.04.txt")));
        using var job = new TestJob(JobKind.PackagesUpgradeSecurity);

        await Apt(root.Files, processes).UpgradeAsync(securityOnly: true, job.Context, Cancel);

        var upgrade = processes.Calls.Where(Units.IsUnitRun).Last();
        Assert.Equal(
            ["/usr/bin/apt-get", .. _aptOptions, "--only-upgrade", "install", "libc-bin", "libc6", "libssl3t64", "perl-base"],
            Units.Command(upgrade));
    }

    [Fact]
    public async Task Apt_security_only_with_nothing_waiting_upgrades_nothing()
    {
        using var root = new TestRoot("ubuntu-24.04");
        var processes = new FakeProcessRunner();
        processes.Respond("apt", ["list", "--upgradable"], _ => FakeProcessRunner.Ok("Listing...\n"));
        using var job = new TestJob(JobKind.PackagesUpgradeSecurity);

        await Apt(root.Files, processes).UpgradeAsync(securityOnly: true, job.Context, Cancel);

        Assert.Single(processes.Calls, Units.IsUnitRun);
        Assert.Contains(await job.LinesAsync(), line => line.Text.Contains("No security updates", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_failed_apt_run_fails_the_job_with_its_exit_code()
    {
        using var root = new TestRoot("ubuntu-24.04");
        var processes = new FakeProcessRunner();
        processes.Respond(
            spec => Units.IsUnitRun(spec) && Units.Command(spec).Contains("upgrade"),
            _ => FakeProcessRunner.Exit(100, error: "E: Could not get lock /var/lib/dpkg/lock-frontend"));
        using var job = new TestJob();

        var failure = await Assert.ThrowsAsync<JobFailedException>(() =>
            Apt(root.Files, processes).UpgradeAsync(securityOnly: false, job.Context, Cancel));

        Assert.Equal(100, failure.ExitCode);
        Assert.Contains("100", failure.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Apt_reads_automatic_updates_from_its_own_configuration()
    {
        using var root = new TestRoot("ubuntu-24.04");
        var processes = new FakeProcessRunner();
        processes.Respond("dpkg-query", ["-W"], _ => FakeProcessRunner.Ok("install ok installed"));
        processes.Respond("apt-config", ["dump"], _ => FakeProcessRunner.Ok(
            "APT::Periodic::Update-Package-Lists \"1\";\nAPT::Periodic::Unattended-Upgrade \"1\";\n"));

        var status = await Apt(root.Files, processes).GetAutomaticUpdatesAsync(Cancel);

        Assert.Equal(new AutoUpdatesInfo(Supported: true, Installed: true, Enabled: true, "unattended-upgrades"), status);
    }

    [Fact]
    public async Task Turning_on_automatic_updates_on_apt_installs_the_tool_and_writes_its_switch()
    {
        using var root = new TestRoot("ubuntu-24.04");
        root.Write("/etc/apt/apt.conf.d/.keep", string.Empty);
        var processes = new FakeProcessRunner();
        processes.Respond("dpkg-query", ["-W"], _ => FakeProcessRunner.Exit(1, error: "no packages found matching unattended-upgrades"));
        using var job = new TestJob(JobKind.AutomaticUpdates);

        await Apt(root.Files, processes).SetAutomaticUpdatesAsync(enabled: true, job.Context, Cancel);

        var install = Assert.Single(processes.Calls, Units.IsUnitRun);
        Assert.Equal(["/usr/bin/apt-get", .. _aptOptions, "install", "unattended-upgrades"], Units.Command(install));
        var written = File.ReadAllText(root.Resolve("/etc/apt/apt.conf.d/20auto-upgrades"));
        Assert.Contains("APT::Periodic::Update-Package-Lists \"1\";", written, StringComparison.Ordinal);
        Assert.Contains("APT::Periodic::Unattended-Upgrade \"1\";", written, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Turning_off_automatic_updates_on_apt_only_flips_the_switch()
    {
        using var root = new TestRoot("ubuntu-24.04");
        root.Write("/etc/apt/apt.conf.d/20auto-upgrades", "APT::Periodic::Unattended-Upgrade \"1\";\n");
        var processes = new FakeProcessRunner();
        using var job = new TestJob(JobKind.AutomaticUpdates);

        await Apt(root.Files, processes).SetAutomaticUpdatesAsync(enabled: false, job.Context, Cancel);

        Assert.DoesNotContain(processes.Calls, Units.IsUnitRun);
        Assert.Contains(
            "APT::Periodic::Unattended-Upgrade \"0\";",
            File.ReadAllText(root.Resolve("/etc/apt/apt.conf.d/20auto-upgrades")),
            StringComparison.Ordinal);
    }

    [Fact]
    public async Task Apt_knows_a_reboot_is_needed_from_the_file_packages_leave_behind()
    {
        using var ubuntu = new TestRoot("ubuntu-24.04");
        using var clean = new TestRoot();

        var needed = await Apt(ubuntu.Files, new FakeProcessRunner()).GetRebootStatusAsync(Cancel);
        var notNeeded = await Apt(clean.Files, new FakeProcessRunner()).GetRebootStatusAsync(Cancel);

        Assert.True(needed.Required);
        Assert.Equal(["linux-image-6.8.0-47-generic", "linux-base"], needed.Packages);
        Assert.False(notNeeded.Required);
        Assert.Empty(notNeeded.Packages);
    }

    [Fact]
    public async Task Dnf_check_update_exits_100_when_there_are_updates_and_that_is_not_an_error()
    {
        using var root = new TestRoot("rocky-9");
        var processes = new FakeProcessRunner();
        processes.Respond(
            spec => FakeProcessRunner.Is(spec, "dnf", "-q", "check-update") && !spec.Arguments.Contains("--security"),
            _ => FakeProcessRunner.Exit(100, Fixtures.Read("dnf/check-update-rocky-9.txt")));
        processes.Respond(
            spec => FakeProcessRunner.Is(spec, "dnf", "-q", "check-update") && spec.Arguments.Contains("--security"),
            _ => FakeProcessRunner.Exit(100, Fixtures.Read("dnf/check-update-security-rocky-9.txt")));

        var packages = await Dnf(root.Files, processes).ListUpgradableAsync(Cancel);

        Assert.Equal(6, packages.Count);
        Assert.Equal(["kernel-core", "openssl-libs"], packages.Where(p => p.Security).Select(p => p.Name).Order(StringComparer.Ordinal));
    }

    [Fact]
    public async Task Dnf_check_update_exiting_1_is_an_error()
    {
        using var root = new TestRoot("rocky-9");
        var processes = new FakeProcessRunner();
        processes.Respond("dnf", ["-q", "check-update"], _ => FakeProcessRunner.Exit(1, error: "Error: Failed to download metadata for repo 'baseos'"));

        var error = await Assert.ThrowsAsync<ProcessFailedException>(() => Dnf(root.Files, processes).ListUpgradableAsync(Cancel));

        Assert.Contains("Failed to download metadata", error.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(false, new[] { "/usr/bin/dnf", "-y", "upgrade" })]
    [InlineData(true, new[] { "/usr/bin/dnf", "-y", "upgrade", "--security" })]
    public async Task Dnf_upgrades_in_a_transient_unit_after_refreshing_metadata(bool securityOnly, string[] command)
    {
        using var root = new TestRoot("rocky-9");
        var processes = new FakeProcessRunner();
        using var job = new TestJob();

        await Dnf(root.Files, processes).UpgradeAsync(securityOnly, job.Context, Cancel);

        var units = processes.Calls.Where(Units.IsUnitRun).ToList();
        Assert.Equal(["/usr/bin/dnf", "-y", "makecache", "--refresh"], Units.Command(units[0]));
        Assert.Equal(command, Units.Command(units[1]));
    }

    [Fact]
    public async Task Turning_on_automatic_updates_on_dnf_installs_dnf_automatic_sets_security_and_starts_its_timer()
    {
        using var root = new TestRoot("rocky-9");
        root.Write("/etc/dnf/automatic.conf", "[commands]\n# comment\nupgrade_type = default\napply_updates = no\n\n[emitters]\nemit_via = stdio\n");
        var processes = new FakeProcessRunner();
        processes.Respond("rpm", ["-q", "dnf-automatic"], _ => FakeProcessRunner.Exit(1, "package dnf-automatic is not installed"));
        using var job = new TestJob(JobKind.AutomaticUpdates);

        await Dnf(root.Files, processes).SetAutomaticUpdatesAsync(enabled: true, job.Context, Cancel);

        Assert.Equal(["/usr/bin/dnf", "-y", "install", "dnf-automatic"], Units.Command(Assert.Single(processes.Calls, Units.IsUnitRun)));
        Assert.Contains(processes.Calls, spec => FakeProcessRunner.Is(spec, "systemctl", "enable", "--now", "dnf-automatic.timer"));
        var conf = File.ReadAllText(root.Resolve("/etc/dnf/automatic.conf"));
        Assert.Contains("upgrade_type = security", conf, StringComparison.Ordinal);
        Assert.Contains("apply_updates = yes", conf, StringComparison.Ordinal);
        Assert.Contains("emit_via = stdio", conf, StringComparison.Ordinal);
        Assert.Contains("# comment", conf, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Turning_off_automatic_updates_on_dnf_stops_the_timer()
    {
        using var root = new TestRoot("rocky-9");
        var processes = new FakeProcessRunner();
        using var job = new TestJob(JobKind.AutomaticUpdates);

        await Dnf(root.Files, processes).SetAutomaticUpdatesAsync(enabled: false, job.Context, Cancel);

        Assert.Contains(processes.Calls, spec => FakeProcessRunner.Is(spec, "systemctl", "disable", "--now", "dnf-automatic.timer"));
        Assert.DoesNotContain(processes.Calls, Units.IsUnitRun);
    }

    [Fact]
    public async Task Dnf_reads_automatic_updates_from_the_timer_and_its_configuration()
    {
        using var root = new TestRoot("rocky-9");
        root.Write("/etc/dnf/automatic.conf", "[commands]\nupgrade_type = security\napply_updates = yes\n");
        var processes = new FakeProcessRunner();
        processes.Respond("systemctl", ["is-enabled"], _ => FakeProcessRunner.Ok("enabled\n"));

        var status = await Dnf(root.Files, processes).GetAutomaticUpdatesAsync(Cancel);

        Assert.Equal(new AutoUpdatesInfo(Supported: true, Installed: true, Enabled: true, "dnf-automatic"), status);
    }

    [Theory]
    [InlineData(1, true)]
    [InlineData(0, false)]
    public async Task Dnf_asks_needs_restarting_whether_a_reboot_is_needed(int exitCode, bool required)
    {
        using var root = new TestRoot("rocky-9");
        root.Write("/usr/bin/needs-restarting", "#!/usr/bin/python3");
        var processes = new FakeProcessRunner();
        processes.Respond("needs-restarting", ["-r"], _ => FakeProcessRunner.Exit(exitCode));

        var status = await Dnf(root.Files, processes).GetRebootStatusAsync(Cancel);

        Assert.Equal(required, status.Required);
    }

    [Fact]
    public async Task Without_needs_restarting_dnf_compares_the_newest_kernel_with_the_running_one()
    {
        using var root = new TestRoot("rocky-9");
        var processes = new FakeProcessRunner();
        processes.Respond("rpm", ["-q", "--last", "kernel-core"], _ => FakeProcessRunner.Ok(Fixtures.Read("dnf/rpm-last-kernel-core.txt")));

        var status = await Dnf(root.Files, processes).GetRebootStatusAsync(Cancel);

        // The running kernel is 5.14.0-503.14.1; 503.21.1 was installed after it.
        Assert.True(status.Required);
        Assert.Equal(["kernel-core-5.14.0-503.21.1.el9_5.x86_64"], status.Packages);
    }

    [Fact]
    public async Task Services_come_from_one_systemctl_call_and_missing_optional_ones_are_hidden()
    {
        using var root = new TestRoot("ubuntu-24.04");
        var processes = new FakeProcessRunner();
        processes.Respond("systemctl", ["show"], _ => FakeProcessRunner.Ok(Fixtures.Read("systemctl/show-ubuntu.txt")));
        var services = new SystemdServices(processes, root.Files, Os("ubuntu-24.04"));

        var listed = await services.ListAsync(Cancel);

        Assert.Equal(
            ["ssh.service", "docker.service", "nginx.service", "cron.service", "fail2ban.service", "unattended-upgrades.service"],
            listed.Select(s => s.Unit));
        var docker = Assert.Single(listed, s => s.Unit == "docker.service");
        Assert.Equal(ServiceState.Active, docker.State);
        Assert.True(docker.CanRestart);
        Assert.Equal(1402, docker.MainPid);
        Assert.True(docker.EnabledAtBoot);
        Assert.Equal(1758370021000 + 12039, docker.ActiveSinceUnixMs);
        var nginx = Assert.Single(listed, s => s.Unit == "nginx.service");
        Assert.Equal(ServiceState.NotInstalled, nginx.State);
        Assert.False(nginx.CanRestart);
        Assert.Equal(ServiceState.Failed, Assert.Single(listed, s => s.Unit == "fail2ban.service").State);
        var query = Assert.Single(processes.Calls);
        Assert.Equal("--property=Id,Description,LoadState,ActiveState,SubState,UnitFileState,MainPID,ActiveEnterTimestampMonotonic", query.Arguments[1]);
    }

    [Fact]
    public async Task Restarting_a_service_that_is_not_installed_is_refused()
    {
        using var root = new TestRoot("ubuntu-24.04");
        var processes = new FakeProcessRunner();
        processes.Respond("systemctl", ["show"], _ => FakeProcessRunner.Ok(Fixtures.Read("systemctl/show-ubuntu.txt")));
        using var job = new TestJob(JobKind.ServiceRestart);

        var refusal = await Assert.ThrowsAsync<JobFailedException>(() =>
            new SystemdServices(processes, root.Files, Os("ubuntu-24.04")).RestartAsync(ManagedService.Nginx, job.Context, Cancel));

        Assert.Contains("not installed", refusal.Message, StringComparison.Ordinal);
        Assert.DoesNotContain(processes.Calls, spec => spec.Arguments.Contains("restart"));
    }

    [Fact]
    public async Task Docker_restarts_through_systemctl()
    {
        using var root = new TestRoot("ubuntu-24.04");
        var processes = new FakeProcessRunner();
        processes.Respond("systemctl", ["show"], _ => FakeProcessRunner.Ok(Fixtures.Read("systemctl/show-ubuntu.txt")));
        using var job = new TestJob(JobKind.ServiceRestart);

        await new SystemdServices(processes, root.Files, Os("ubuntu-24.04")).RestartAsync(ManagedService.Docker, job.Context, Cancel);

        Assert.Contains(processes.Calls, spec => spec.Arguments.SequenceEqual(["restart", "docker.service"]));
    }

    [Fact]
    public async Task Nginx_restarts_only_when_its_configuration_passes_the_test()
    {
        using var root = new TestRoot("rocky-9");
        var processes = new FakeProcessRunner();
        processes.Respond("systemctl", ["show"], _ => FakeProcessRunner.Ok(Fixtures.Read("systemctl/show-rocky.txt")));
        processes.Respond("nginx", ["-t"], _ => FakeProcessRunner.Exit(1, error: "nginx: [emerg] unknown directive \"proxy_passs\" in /etc/nginx/conf.d/app.conf:12"));
        using var job = new TestJob(JobKind.ServiceRestart);

        var refusal = await Assert.ThrowsAsync<JobFailedException>(() =>
            new SystemdServices(processes, root.Files, Os("rocky-9")).RestartAsync(ManagedService.Nginx, job.Context, Cancel));

        Assert.Contains("configuration test", refusal.Message, StringComparison.Ordinal);
        Assert.DoesNotContain(processes.Calls, spec => spec.Arguments.Contains("restart"));
        Assert.Contains(await job.LinesAsync(), line => line.Text.Contains("unknown directive", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_reboot_is_scheduled_from_a_transient_timer()
    {
        var processes = new FakeProcessRunner();
        using var job = new TestJob(JobKind.Reboot);

        await new SystemdPower(Units.Runner(processes)).ScheduleRebootAsync(job.Context, TimeSpan.FromSeconds(5), Cancel);

        var schedule = Assert.Single(processes.Calls);
        Assert.Equal(job.Context.UnitFor("reboot"), Units.UnitName(schedule));
        Assert.Contains("--on-active=5s", schedule.Arguments);
        Assert.Equal(["/usr/bin/systemctl", "reboot"], Units.Command(schedule));
    }

    [Fact]
    public void Ini_values_are_set_in_their_section_and_everything_else_is_kept()
    {
        var text = new StringBuilder()
            .Append("[commands]\n# upgrade_type = default\nupgrade_type=default\n\n[emitters]\nemit_via = motd\n")
            .ToString();

        var updated = IniFile.Set(IniFile.Set(text, "commands", "upgrade_type", "security"), "commands", "apply_updates", "yes");
        var added = IniFile.Set("", "commands", "apply_updates", "yes");

        Assert.Equal("[commands]\n# upgrade_type = default\nupgrade_type = security\napply_updates = yes\n\n[emitters]\nemit_via = motd\n", updated);
        Assert.Equal("[commands]\napply_updates = yes\n", added);
        Assert.Equal("yes", IniFile.Get(updated, "commands", "apply_updates"));
        Assert.Null(IniFile.Get(updated, "emitters", "apply_updates"));
    }

    private static OsInfo Os(string fixture) => OsRelease.Describe(OsRelease.Parse(Fixtures.Read($"os-release/{fixture}")));

    private static AptPackageManager Apt(SystemFiles files, FakeProcessRunner processes) =>
        new(processes, Units.Runner(processes), files);

    private static DnfPackageManager Dnf(SystemFiles files, FakeProcessRunner processes) =>
        new(processes, Units.Runner(processes), files);

    private static LinuxSystemInfo NewSystemInfo(
        SystemFiles files,
        FakeProcessRunner processes,
        IPackageManager packages,
        IReadOnlyList<NetworkInterfaceInfo> networks,
        TimeProvider? time = null) =>
        new(
            files,
            new LinuxSystemProbe(files, _stats),
            packages,
            processes,
            OsRelease.Describe(OsRelease.Parse(files.ReadText(OsRelease.Path) ?? string.Empty)),
            time ?? TimeProvider.System,
            () => networks);
}
