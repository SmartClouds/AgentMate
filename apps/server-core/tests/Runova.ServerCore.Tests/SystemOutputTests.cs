using Runova.ServerCore.Contracts;
using Runova.ServerCore.Platform;

namespace Runova.ServerCore.Tests;

/// <summary>
/// The Linux readers behind the Overview: /proc (CPU, memory, network, disks, load, uptime),
/// mounted filesystems, the CPU model, services from `systemctl show` and time sync from
/// `timedatectl show`, on fixtures from an Ubuntu and a Rocky server.
/// </summary>
public sealed class SystemOutputTests
{
    [Fact]
    public void Cpu_times_come_from_the_first_line_of_proc_stat()
    {
        var times = ProcParsers.ParseCpuTimes(Fixtures.Read("hosts/ubuntu-24.04/proc/stat"));

        Assert.Equal(2255349, times.User);
        Assert.Equal(1324, times.Nice);
        Assert.Equal(1106652, times.System);
        Assert.Equal(272839218, times.Idle);
        Assert.Equal(90418, times.Iowait);
        Assert.Equal(42170, times.SoftIrq);
        Assert.Equal(81203, times.Steal);
        Assert.Equal(2255349 + 1324 + 1106652 + 272839218 + 90418 + 0 + 42170 + 81203, times.Total);
    }

    [Fact]
    public void Cpu_use_is_the_busy_share_of_the_time_between_two_readings()
    {
        var before = new CpuTimes(User: 100, Nice: 0, System: 50, Idle: 800, Iowait: 40, Irq: 0, SoftIrq: 10, Steal: 0);
        var after = before with { User = 160, System = 70, Idle = 880, Iowait = 60, SoftIrq = 20, Steal = 10 };

        var use = CpuTimes.Usage(before, after);

        // 200 ticks passed: 100 busy (user 60, system 20, softirq 10, steal 10), 80 idle and 20
        // waiting on I/O, which counts as idle: the CPU could have run something else.
        Assert.Equal(50.0, use.BusyPercent, precision: 6);
        Assert.Equal(10.0, use.IowaitPercent, precision: 6);
        Assert.Equal(5.0, use.StealPercent, precision: 6);
    }

    [Fact]
    public void No_time_between_readings_is_no_cpu_use()
    {
        var reading = new CpuTimes(1, 1, 1, 1, 1, 1, 1, 1);

        Assert.Equal(0, CpuTimes.Usage(reading, reading).BusyPercent);
    }

    [Theory]
    [InlineData("ubuntu-24.04", 8131468L, 5480212L, 2097148L, 1835004L)]
    [InlineData("rocky-9", 3735940L, 1820444L, 4116476L, 3901228L)]
    public void Memory_comes_from_meminfo_in_bytes(string host, long totalKb, long availableKb, long swapTotalKb, long swapFreeKb)
    {
        var memory = ProcParsers.ParseMemory(Fixtures.Read($"hosts/{host}/proc/meminfo"));

        Assert.Equal(totalKb * 1024, memory.TotalBytes);
        Assert.Equal(availableKb * 1024, memory.AvailableBytes);
        Assert.Equal((totalKb - availableKb) * 1024, memory.UsedBytes);
        Assert.Equal(swapTotalKb * 1024, memory.SwapTotalBytes);
        Assert.Equal((swapTotalKb - swapFreeKb) * 1024, memory.SwapUsedBytes);
    }

    [Fact]
    public void Old_kernels_without_mem_available_estimate_it()
    {
        var memory = ProcParsers.ParseMemory("MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 50 kB\nCached: 250 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n");

        Assert.Equal(400 * 1024, memory.AvailableBytes);
    }

    [Fact]
    public void Network_traffic_counts_real_interfaces_not_loopback_or_container_bridges()
    {
        var ubuntu = ProcParsers.ParseNetwork(Fixtures.Read("hosts/ubuntu-24.04/proc/net/dev"));
        var rocky = ProcParsers.ParseNetwork(Fixtures.Read("hosts/rocky-9/proc/net/dev"));

        Assert.Equal(91827365121, ubuntu.ReceivedBytes);
        Assert.Equal(18273645528, ubuntu.TransmittedBytes);
        Assert.Equal(20391847231, rocky.ReceivedBytes);
        Assert.Equal(3920184721, rocky.TransmittedBytes);
    }

    [Fact]
    public void Disk_traffic_counts_whole_disks_once_not_partitions_loops_or_mapper_devices()
    {
        var ubuntu = ProcParsers.ParseDisks(Fixtures.Read("hosts/ubuntu-24.04/proc/diskstats"));
        var rocky = ProcParsers.ParseDisks(Fixtures.Read("hosts/rocky-9/proc/diskstats"));

        // Sectors are always 512 bytes in diskstats. Ubuntu: sda and sdb; Rocky: vda (dm-* sit on it).
        Assert.Equal((118203945L + 2093841L) * 512, ubuntu.ReadBytes);
        Assert.Equal((482019384L + 4829301L) * 512, ubuntu.WrittenBytes);
        Assert.Equal(30291844L * 512, rocky.ReadBytes);
        Assert.Equal(90213848L * 512, rocky.WrittenBytes);
    }

    [Fact]
    public void Load_and_uptime_are_read_as_numbers()
    {
        var load = ProcParsers.ParseLoad(Fixtures.Read("hosts/rocky-9/proc/loadavg"));

        Assert.Equal((1.08, 0.92, 0.87), (load.One, load.Five, load.Fifteen));
        Assert.Equal(291822.04, ProcParsers.ParseUptimeSeconds(Fixtures.Read("hosts/rocky-9/proc/uptime")), precision: 2);
    }

    [Fact]
    public void Boot_time_comes_from_proc_stat()
    {
        Assert.Equal(1758370021, ProcParsers.ParseBootTime(Fixtures.Read("hosts/ubuntu-24.04/proc/stat")));
    }

    [Fact]
    public void The_cpu_model_and_cores_come_from_cpuinfo()
    {
        var ubuntu = ProcParsers.ParseCpuInfo(Fixtures.Read("hosts/ubuntu-24.04/proc/cpuinfo"));
        var rocky = ProcParsers.ParseCpuInfo(Fixtures.Read("hosts/rocky-9/proc/cpuinfo"));

        Assert.Equal(new CpuInfo("AMD EPYC 7B13", LogicalCores: 4, PhysicalCores: 4, Sockets: 1), ubuntu);
        // KVM often shows each virtual CPU as a socket of its own.
        Assert.Equal(new CpuInfo("Intel Xeon Processor (Icelake)", LogicalCores: 2, PhysicalCores: 2, Sockets: 2), rocky);
    }

    [Fact]
    public void An_arm_cpu_without_a_model_name_is_named_from_its_part_number()
    {
        var arm = ProcParsers.ParseCpuInfo(Fixtures.Read("cpuinfo/arm64-neoverse-n1"));

        Assert.Equal("ARM Neoverse-N1", arm.Model);
        Assert.Equal(2, arm.LogicalCores);
    }

    [Fact]
    public void Real_filesystems_are_kept_and_the_rest_of_the_mount_table_is_not()
    {
        var mounts = ProcParsers.ParseMounts(Fixtures.Read("hosts/ubuntu-24.04/proc/mounts"));

        Assert.Equal(
            [
                ("/", "/dev/sda1", "ext4"),
                ("/boot", "/dev/sda16", "ext4"),
                ("/boot/efi", "/dev/sda15", "vfat"),
                ("/mnt/data volume", "/dev/sdb", "ext4"),
            ],
            mounts.Select(m => (m.MountPoint, m.Device, m.FileSystem)));
    }

    [Fact]
    public void Rocky_mounts_its_root_from_lvm_on_xfs()
    {
        var mounts = ProcParsers.ParseMounts(Fixtures.Read("hosts/rocky-9/proc/mounts"));

        Assert.Equal(("/", "/dev/mapper/rl-root", "xfs"), (mounts[0].MountPoint, mounts[0].Device, mounts[0].FileSystem));
        Assert.Equal(["/", "/boot", "/boot/efi"], mounts.Select(m => m.MountPoint));
    }

    [Fact]
    public void Systemctl_show_blocks_become_one_service_each()
    {
        var units = SystemctlOutput.ParseShow(Fixtures.Read("systemctl/show-ubuntu.txt"));

        Assert.Equal(7, units.Count);
        var ssh = units[0];
        Assert.Equal("ssh.service", ssh["Id"]);
        Assert.Equal("active", ssh["ActiveState"]);
        Assert.Equal("1021", ssh["MainPID"]);
    }

    [Theory]
    [InlineData("active", "running", ServiceState.Active)]
    [InlineData("inactive", "dead", ServiceState.Inactive)]
    [InlineData("failed", "failed", ServiceState.Failed)]
    [InlineData("activating", "start", ServiceState.Activating)]
    [InlineData("deactivating", "stop", ServiceState.Deactivating)]
    [InlineData("reloading", "reload", ServiceState.Reloading)]
    [InlineData("maintenance", "", ServiceState.Unknown)]
    public void Service_states_map_from_systemd(string active, string sub, ServiceState expected)
    {
        Assert.Equal(expected, SystemctlOutput.StateOf("loaded", active, sub));
    }

    [Fact]
    public void A_unit_that_is_not_there_is_not_installed()
    {
        Assert.Equal(ServiceState.NotInstalled, SystemctlOutput.StateOf("not-found", "inactive", "dead"));
    }

    [Fact]
    public void Time_sync_comes_from_timedatectl()
    {
        var synced = SystemctlOutput.ParseTimeSync(Fixtures.Read("timedatectl/show-synced.txt"), "systemd-timesyncd");
        var unsynced = SystemctlOutput.ParseTimeSync(Fixtures.Read("timedatectl/show-unsynced.txt"), null);

        Assert.Equal(new TimeSyncInfo(Synchronized: true, NtpEnabled: true, TimeZone: "Etc/UTC", Service: "systemd-timesyncd"), synced);
        Assert.Equal(new TimeSyncInfo(Synchronized: false, NtpEnabled: false, TimeZone: "America/New_York"), unsynced);
    }

    [Theory]
    [InlineData("203.0.113.10", true)]
    [InlineData("8.8.8.8", true)]
    [InlineData("2a01:4f8:c17:1234::1", true)]
    [InlineData("10.0.0.5", false)]
    [InlineData("172.17.0.1", false)]
    [InlineData("192.168.1.20", false)]
    [InlineData("100.64.3.2", false)]
    [InlineData("127.0.0.1", false)]
    [InlineData("169.254.169.254", false)]
    [InlineData("::1", false)]
    [InlineData("fe80::1", false)]
    [InlineData("fd00::1", false)]
    public void Only_globally_routable_addresses_count_as_public(string address, bool isPublic)
    {
        Assert.Equal(isPublic, NetworkAddresses.IsPublic(System.Net.IPAddress.Parse(address)));
    }
}
