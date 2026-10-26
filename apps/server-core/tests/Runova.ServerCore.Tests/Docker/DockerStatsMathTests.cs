using Runova.ServerCore.Docker;

namespace Runova.ServerCore.Tests.Docker;

/// <summary>
/// The figures `docker stats` prints, computed as the Docker CLI computes them
/// (cli/command/container/stats_helpers.go): CPU from the deltas against the engine's previous
/// reading, memory without the inactive file cache for each cgroup version, IO as totals.
/// </summary>
public sealed class DockerStatsMathTests
{
    private static StatsReading Reading(
        ulong cpu = 2_000,
        ulong preCpu = 1_000,
        ulong system = 20_000,
        ulong preSystem = 10_000,
        uint online = 4,
        int perCpu = 0,
        ulong usage = 1_000,
        ulong limit = 10_000,
        Dictionary<string, ulong>? memory = null,
        BlockIoEntry[]? blockIo = null,
        NetworkTotals[]? networks = null) =>
        new(
            DateTimeOffset.UnixEpoch,
            cpu,
            preCpu,
            system,
            preSystem,
            online,
            perCpu,
            usage,
            limit,
            memory ?? [],
            blockIo ?? [],
            networks ?? [],
            3);

    [Fact]
    public void Cpu_is_the_container_share_of_the_system_delta_times_the_online_cpus()
    {
        var sample = DockerStatsMath.Sample("c", Reading(), 0);

        Assert.Equal(40.0, sample.CpuPercent, precision: 9);
        Assert.Equal(4, sample.OnlineCpus);
    }

    [Fact]
    public void Without_online_cpus_the_per_cpu_counters_say_how_many_there_are()
    {
        var sample = DockerStatsMath.Sample("c", Reading(online: 0, perCpu: 2), 0);

        Assert.Equal(20.0, sample.CpuPercent, precision: 9);
        Assert.Equal(2, sample.OnlineCpus);
    }

    [Theory]
    [InlineData(1_000UL, 1_000UL, 20_000UL, 10_000UL)]
    [InlineData(2_000UL, 1_000UL, 10_000UL, 10_000UL)]
    [InlineData(0UL, 0UL, 20_000UL, 0UL)]
    public void No_cpu_delta_or_no_system_delta_is_zero_percent(ulong cpu, ulong preCpu, ulong system, ulong preSystem)
    {
        Assert.Equal(0.0, DockerStatsMath.Sample("c", Reading(cpu, preCpu, system, preSystem), 0).CpuPercent);
    }

    [Fact]
    public void Cgroup_v1_memory_leaves_out_total_inactive_file()
    {
        var sample = DockerStatsMath.Sample(
            "c",
            Reading(usage: 1_000, limit: 4_000, memory: new() { ["total_inactive_file"] = 200, ["inactive_file"] = 100, ["cache"] = 600 }),
            0);

        Assert.Equal(800, sample.MemoryUsedBytes);
        Assert.Equal(20.0, sample.MemoryPercent, precision: 9);
    }

    [Fact]
    public void Cgroup_v2_memory_leaves_out_inactive_file()
    {
        var sample = DockerStatsMath.Sample("c", Reading(usage: 1_000, memory: new() { ["inactive_file"] = 300, ["file"] = 900 }), 0);

        Assert.Equal(700, sample.MemoryUsedBytes);
    }

    [Fact]
    public void An_inactive_figure_larger_than_the_usage_is_ignored_and_no_limit_is_zero_percent()
    {
        var sample = DockerStatsMath.Sample("c", Reading(usage: 1_000, limit: 0, memory: new() { ["inactive_file"] = 5_000 }), 0);

        Assert.Equal(1_000, sample.MemoryUsedBytes);
        Assert.Equal(0.0, sample.MemoryPercent);
    }

    [Fact]
    public void Block_io_counts_reads_and_writes_by_the_first_letter_of_the_op_and_network_sums_every_interface()
    {
        var sample = DockerStatsMath.Sample(
            "c",
            Reading(
                blockIo: [new("Read", 10), new("read", 5), new("Write", 7), new("Total", 22), new("Sync", 1), new(string.Empty, 99)],
                networks: [new(100, 10), new(50, 5)]),
            0);

        Assert.Equal(15, sample.BlockReadBytes);
        Assert.Equal(7, sample.BlockWrittenBytes);
        Assert.Equal(150, sample.NetworkReceivedBytes);
        Assert.Equal(15, sample.NetworkTransmittedBytes);
        Assert.Equal(3, sample.Pids);
    }
}
