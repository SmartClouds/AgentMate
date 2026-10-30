using System.Globalization;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Docker;

namespace Runova.ServerCore.Tests.Docker;

/// <summary>
/// The real engine client (Docker.DotNet over a Unix socket) against the fake daemon replaying
/// Docker 29 payloads: version negotiation, containers, lifecycle requests, stats (AC1 against
/// what `docker stats` printed for the same payloads), logs, exec, images, volumes, networks,
/// disk usage, prunes and events.
/// </summary>
public sealed class DockerEngineTests
{
    private const string Api = "8ac808e7678e266694d79428f372075e39d3b8f1c90c63393d47d9e63476c1e1";

    private static readonly JsonSerializerOptions _caseInsensitive = new() { PropertyNameCaseInsensitive = true };

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private static DockerEngine Engine(FakeDockerDaemon daemon) =>
        new(daemon.Endpoint, NullLogger<DockerEngine>.Instance);

    [Fact]
    public async Task It_speaks_the_newest_api_it_knows_with_a_newer_engine()
    {
        await using var daemon = await FakeDockerDaemon.StartAsync(apiVersion: "1.56");
        using var engine = Engine(daemon);

        var version = await engine.GetVersionAsync(Cancel);
        await engine.ListContainersAsync(Cancel);

        Assert.Equal("29.8.1", version!.Version);
        Assert.Equal(DockerEngine.MaxApiVersion.ToString(), version.NegotiatedApiVersion);
        Assert.All(daemon.RequestedVersions, requested => Assert.Equal(DockerEngine.MaxApiVersion.ToString(), requested));
        Assert.NotEmpty(daemon.RequestedVersions);
    }

    [Fact]
    public async Task It_speaks_an_older_engine_s_own_version()
    {
        await using var daemon = await FakeDockerDaemon.StartAsync(apiVersion: "1.47");
        using var engine = Engine(daemon);

        var version = await engine.GetVersionAsync(Cancel);
        await engine.ListContainersAsync(Cancel);

        Assert.Equal("1.47", version!.NegotiatedApiVersion);
        Assert.Contains("1.47", daemon.RequestedVersions);
        Assert.DoesNotContain(DockerEngine.MaxApiVersion.ToString(), daemon.RequestedVersions);
    }

    [Fact]
    public async Task An_engine_older_than_the_minimum_is_unavailable_with_the_reason()
    {
        await using var daemon = await FakeDockerDaemon.StartAsync(apiVersion: "1.41", minApiVersion: "1.24");
        using var engine = Engine(daemon);

        var refusal = await Assert.ThrowsAsync<DockerUnavailableException>(() => engine.ListContainersAsync(Cancel));

        Assert.Contains("1.41", refusal.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Nothing_listening_means_no_version_and_unavailable_calls()
    {
        using var engine = new DockerEngine(new Uri("unix:///tmp/runova-no-docker-here.sock"), NullLogger<DockerEngine>.Instance);

        Assert.Null(await engine.GetVersionAsync(Cancel));
        await Assert.ThrowsAsync<DockerUnavailableException>(() => engine.ListContainersAsync(Cancel));
    }

    [Fact]
    public async Task Containers_come_with_their_compose_project_ports_and_state()
    {
        await using var daemon = await FakeDockerDaemon.StartAsync();
        using var engine = Engine(daemon);

        var containers = await engine.ListContainersAsync(Cancel);

        Assert.Equal(["migrate-once", "shop-api-1", "shop-worker-1", "toolbox"], containers.Select(c => c.Summary.Name).Order(StringComparer.Ordinal));
        var api = containers.Single(c => c.Summary.Name == "shop-api-1").Summary;
        Assert.Equal(Api, api.Id);
        Assert.Equal(("shop", "api", 1), (api.ComposeProject, api.ComposeService, api.ComposeNumber));
        Assert.Equal(ContainerState.Running, api.State);
        Assert.Equal("debian:13", api.Image);
        Assert.Contains(new ContainerPort(8080, "tcp", "127.0.0.1", 18080), api.Ports);
        Assert.Contains(api.Ports, port => port.PrivatePort == 8443 && port.HostPort == 18443);
        Assert.Equal(api.Ports.Length, api.Ports.Distinct().Count());
        var once = containers.Single(c => c.Summary.Name == "migrate-once").Summary;
        Assert.Equal(ContainerState.Exited, once.State);
        Assert.Null(once.ComposeProject);
    }

    [Fact]
    public async Task Inspect_lists_environment_names_and_keeps_the_values_apart()
    {
        await using var daemon = await FakeDockerDaemon.StartAsync();
        using var engine = Engine(daemon);

        var inspection = await engine.InspectContainerAsync("shop-api-1", Cancel);

        var details = inspection.Details;
        Assert.Contains("API_TOKEN", details.EnvKeys);
        Assert.Contains("DB_PASSWORD", details.EnvKeys);
        Assert.DoesNotContain(details.EnvKeys, key => key.Contains('=', StringComparison.Ordinal));
        Assert.Contains(new KeyValuePair<string, string>("DB_PASSWORD", "s3cret-db-pass-981"), inspection.Environment);
        Assert.Contains(details.Mounts, mount => mount.Type == "volume" && mount.Name == "shop_data" && mount.Destination == "/data");
        Assert.Contains(details.Networks, network => network.Network == "shop_default" && network.IpAddress is not null);
        Assert.Equal("shop", details.Summary.ComposeProject);
        Assert.Equal(ContainerState.Running, details.Summary.State);
        Assert.NotNull(details.StartedAtUnixMs);
        Assert.False(details.Tty);
        Assert.Contains(details.Labels, label => label.Name == "com.docker.compose.service" && label.Value == "api");
    }

    [Fact]
    public async Task Inspecting_a_missing_container_says_so()
    {
        await using var daemon = await FakeDockerDaemon.StartAsync();
        using var engine = Engine(daemon);

        var missing = await Assert.ThrowsAsync<DockerNotFoundException>(() => engine.InspectContainerAsync("no-such-container", Cancel));

        Assert.Contains("No such container", missing.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Lifecycle_calls_send_what_the_engine_expects()
    {
        await using var daemon = await FakeDockerDaemon.StartAsync();
        using var engine = Engine(daemon);

        await engine.StopContainerAsync("toolbox", 5, Cancel);
        await engine.RestartContainerAsync("toolbox", null, Cancel);
        await engine.KillContainerAsync("toolbox", "SIGTERM", Cancel);
        await engine.PauseContainerAsync("toolbox", Cancel);
        await engine.UnpauseContainerAsync("toolbox", Cancel);
        await engine.StartContainerAsync("toolbox", Cancel);
        await engine.RemoveContainerAsync("migrate-once", removeVolumes: true, force: false, Cancel);
        var running = await Assert.ThrowsAsync<DockerRequestException>(() => engine.RemoveContainerAsync("toolbox", false, false, Cancel));

        var requests = daemon.Requests.ToList();
        Assert.Contains("POST /containers/toolbox/stop?t=5", requests);
        Assert.Contains("POST /containers/toolbox/restart", requests);
        Assert.Contains("POST /containers/toolbox/kill?signal=SIGTERM", requests);
        Assert.Contains("POST /containers/toolbox/pause", requests);
        Assert.Contains("POST /containers/toolbox/unpause", requests);
        Assert.Contains("POST /containers/toolbox/start", requests);
        var remove = Assert.Single(requests, r => r.StartsWith("DELETE /containers/migrate-once", StringComparison.Ordinal));
        Assert.Matches("v=(1|true|True)", remove);
        Assert.Contains("container is running", running.Message, StringComparison.Ordinal);
    }

    /// <summary>AC1: the same payloads, and the same figures `docker stats` printed for them.</summary>
    [Theory]
    [InlineData("shop-api-1", 0, "s1.json")]
    [InlineData("shop-api-1", 2, "s3.json")]
    [InlineData("oneshot", 0, "stats-v2-oneshot.json")]
    [InlineData("legacy-v1", 0, "stats-v1.json")]
    public async Task Stats_figures_match_docker_stats_for_the_recorded_payloads(string container, int index, string recorded)
    {
        await using var daemon = await FakeDockerDaemon.StartAsync();
        using var engine = Engine(daemon);
        var expected = CliStats(recorded);

        var readings = new List<StatsReading>();
        await foreach (var reading in engine.StreamStatsAsync(container, Cancel))
        {
            readings.Add(reading);
            if (readings.Count > index)
            {
                break;
            }
        }

        var sample = DockerStatsMath.Sample(container, readings[index], 0);
        Assert.Equal(expected.GetProperty("CPUPerc").GetString(), Percent(sample.CpuPercent));
        Assert.Equal(expected.GetProperty("MemPerc").GetString(), Percent(sample.MemoryPercent));
        Assert.Equal(expected.GetProperty("MemUsage").GetString(), $"{BinarySize(sample.MemoryUsedBytes)} / {BinarySize(sample.MemoryLimitBytes)}");
        Assert.Equal(expected.GetProperty("NetIO").GetString(), $"{DecimalSize(sample.NetworkReceivedBytes)} / {DecimalSize(sample.NetworkTransmittedBytes)}");
        Assert.Equal(expected.GetProperty("BlockIO").GetString(), $"{DecimalSize(sample.BlockReadBytes)} / {DecimalSize(sample.BlockWrittenBytes)}");
        Assert.Equal(expected.GetProperty("PIDs").GetString(), sample.Pids.ToString(CultureInfo.InvariantCulture));
    }

    [Fact]
    public async Task Logs_come_apart_by_stream_with_docker_timestamps_and_tty_logs_are_all_stdout()
    {
        await using var daemon = await FakeDockerDaemon.StartAsync();
        using var engine = Engine(daemon);

        var api = await ReadLogsAsync(engine, "shop-api-1", new LogOptions(12, "1790856000.000000000", Follow: false));
        var worker = await ReadLogsAsync(engine, "shop-worker-1", new LogOptions(5, null, Follow: false));

        Assert.Contains("GET /orders/", api[ContainerLogSource.Stdout], StringComparison.Ordinal);
        Assert.Contains("warn: slow query", api[ContainerLogSource.Stderr], StringComparison.Ordinal);
        Assert.DoesNotContain("warn:", api[ContainerLogSource.Stdout], StringComparison.Ordinal);
        Assert.Matches(@"^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z ", api[ContainerLogSource.Stdout]);
        Assert.Contains("processed job", worker[ContainerLogSource.Stdout], StringComparison.Ordinal);
        Assert.Equal(string.Empty, worker[ContainerLogSource.Stderr]);
        var request = Assert.Single(daemon.Requests, r => r.Contains("/containers/shop-api-1/logs", StringComparison.Ordinal));
        Assert.Contains("tail=12", request, StringComparison.Ordinal);
        Assert.Contains("since=1790856000.000000000", request, StringComparison.Ordinal);
        Assert.Matches("timestamps=(1|true|True)", request);
    }

    [Fact]
    public async Task A_console_runs_docker_exec_with_a_tty_both_ways_and_reports_the_exit_code()
    {
        await using var daemon = await FakeDockerDaemon.StartAsync();
        using var engine = Engine(daemon);

        await using var session = await engine.StartExecAsync("toolbox", new ExecOptions(["/bin/sh"], "root", 100, 30), Cancel);
        await session.WriteAsync(Encoding.UTF8.GetBytes("ls /data\r"), Cancel);
        var screen = await ReadUntilAsync(session, "you typed: ls /data");
        await session.ResizeAsync(120, 40, Cancel);
        await session.WriteAsync(Encoding.UTF8.GetBytes("fail\r"), Cancel);
        await ReadToEndAsync(session);
        var exitCode = await session.ExitCodeAsync(Cancel);

        Assert.StartsWith("$ ls /data", screen, StringComparison.Ordinal);
        Assert.Equal(3, exitCode);
        // The engine reads request bodies without regard to case ("TTY" is its "Tty").
        var body = JsonSerializer.Deserialize<ExecBody>(Assert.Single(daemon.ExecBodies), _caseInsensitive)!;
        Assert.True(body.Tty);
        Assert.True(body.AttachStdin);
        Assert.Equal(["/bin/sh"], body.Cmd);
        Assert.Equal("root", body.User);
        Assert.Equal([30, 100], body.ConsoleSize);
        Assert.Contains(daemon.Requests, r => r.Contains("/resize?", StringComparison.Ordinal) && r.Contains("h=40", StringComparison.Ordinal) && r.Contains("w=120", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_pull_asks_for_one_tag_and_reports_layer_progress()
    {
        await using var daemon = await FakeDockerDaemon.StartAsync();
        using var engine = Engine(daemon);
        Assert.True(DockerNames.TryParseReference("busybox:1.37", out var busybox));
        Assert.True(DockerNames.TryParseReference("busybox:no-such-tag-runova", out var missing));
        var progress = new List<PullProgress>();

        await engine.PullImageAsync(busybox, progress.Add, Cancel);
        var failure = await Assert.ThrowsAnyAsync<Exception>(() => engine.PullImageAsync(missing, _ => { }, Cancel));

        Assert.Contains(progress, p => p.Status == "Downloading" && p.Current > 0 && p.Total > p.Current);
        Assert.Contains(progress, p => p.Status?.StartsWith("Status: Downloaded newer image", StringComparison.Ordinal) == true);
        Assert.Contains(daemon.Requests, r => r.StartsWith("POST /images/create?", StringComparison.Ordinal) && r.Contains("fromImage=busybox", StringComparison.Ordinal) && r.Contains("tag=1.37", StringComparison.Ordinal));
        Assert.True(failure is DockerNotFoundException or DockerRequestException);
        Assert.Contains("not found", failure.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Images_volumes_networks_and_disk_usage_come_with_who_uses_them()
    {
        await using var daemon = await FakeDockerDaemon.StartAsync();
        using var engine = Engine(daemon);

        var images = await engine.ListImagesAsync(Cancel);
        var volumes = await engine.ListVolumesAsync(Cancel);
        var networks = await engine.ListNetworksAsync(Cancel);
        var usage = await engine.GetDiskUsageAsync(Cancel);

        var debian = Assert.Single(images);
        Assert.Contains("debian:13", debian.Tags);
        Assert.Equal(4, debian.Containers);
        Assert.True(debian.SizeBytes > 0);
        var data = Assert.Single(volumes, v => v.Name == "shop_data");
        Assert.Equal("shop", data.ComposeProject);
        Assert.Equal(1, data.Containers);
        var shop = Assert.Single(networks, n => n.Name == "shop_default");
        Assert.Equal(2, shop.Containers);
        Assert.False(shop.BuiltIn);
        Assert.NotEmpty(shop.Subnets);
        Assert.True(Assert.Single(networks, n => n.Name == "bridge").BuiltIn);
        Assert.Equal(new DockerDiskUsageEntry(89, 16, 53230593496, 39286478202), usage.Images);
        Assert.Equal(new DockerDiskUsageEntry(25, 9, 1245184, 1138688), usage.Containers);
        Assert.Equal(382, usage.BuildCache.Count);
    }

    [Fact]
    public async Task Prunes_report_what_they_removed_and_reclaimed()
    {
        await using var daemon = await FakeDockerDaemon.StartAsync();
        using var engine = Engine(daemon);

        var containers = await engine.PruneAsync(DockerPruneTarget.Containers, false, Cancel);
        var images = await engine.PruneAsync(DockerPruneTarget.Images, allImages: true, Cancel);
        var networks = await engine.PruneAsync(DockerPruneTarget.Networks, false, Cancel);

        Assert.Equal(new DockerPruneResult(1, 4096), containers);
        Assert.Equal(new DockerPruneResult(2, 73400320), images);
        Assert.Equal(new DockerPruneResult(1, 0), networks);
        Assert.Contains(daemon.Requests, r => r.StartsWith("POST /images/prune", StringComparison.Ordinal) && Uri.UnescapeDataString(r).Contains("dangling", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Build_cache_prune_clears_all_of_it_and_reports_the_space()
    {
        await using var daemon = await FakeDockerDaemon.StartAsync(apiVersion: "1.47");
        using var engine = Engine(daemon);

        var cache = await engine.PruneAsync(DockerPruneTarget.BuildCache, false, Cancel);

        Assert.Equal(new DockerPruneResult(3, 432013312), cache);
        Assert.Contains(daemon.Requests, r => r.StartsWith("POST /build/prune", StringComparison.Ordinal) && r.Contains("all=true", StringComparison.Ordinal));
        Assert.Equal("1.47", daemon.RequestedVersions.Last());
    }

    [Fact]
    public async Task Events_resume_from_a_cursor_to_the_nanosecond()
    {
        await using var daemon = await FakeDockerDaemon.StartAsync();
        using var engine = Engine(daemon);
        var cursor = new EventCursor(1790856068866718122);

        var events = new List<EngineEvent>();
        await foreach (var engineEvent in engine.StreamEventsAsync(cursor, Cancel))
        {
            events.Add(engineEvent);
            if (events.Count == 8)
            {
                break;
            }
        }

        Assert.Equal(cursor.UnixNanoseconds, events[0].TimeNano);
        Assert.Equal(("network", "disconnect"), (events[0].Type, events[0].Action));
        Assert.Equal(("container", "unpause"), (events[^1].Type, events[^1].Action));
        Assert.Equal("toolbox", events[2].Attributes["name"]);
        Assert.Contains(daemon.Requests, r => r.Contains("since=1790856068.866718122", StringComparison.Ordinal));
    }

    private sealed record ExecBody(bool Tty, bool AttachStdin, string[] Cmd, string User, int[] ConsoleSize);

    private static async Task<Dictionary<ContainerLogSource, string>> ReadLogsAsync(DockerEngine engine, string container, LogOptions options)
    {
        var text = new Dictionary<ContainerLogSource, StringBuilder> { [ContainerLogSource.Stdout] = new(), [ContainerLogSource.Stderr] = new() };
        await foreach (var chunk in engine.ReadLogsAsync(container, options, Cancel))
        {
            text[chunk.Stream].Append(Encoding.UTF8.GetString(chunk.Data.Span));
        }

        return text.ToDictionary(entry => entry.Key, entry => entry.Value.ToString());
    }

    private static async Task<string> ReadUntilAsync(IExecSession session, string expected)
    {
        var text = new StringBuilder();
        var buffer = new byte[256];
        while (!text.ToString().Contains(expected, StringComparison.Ordinal))
        {
            var read = await session.ReadAsync(buffer, Cancel).AsTask().WaitAsync(TimeSpan.FromSeconds(10), Cancel);
            Assert.True(read > 0, $"The console ended early: {text}");
            text.Append(Encoding.UTF8.GetString(buffer, 0, read));
        }

        return text.ToString();
    }

    private static async Task ReadToEndAsync(IExecSession session)
    {
        var buffer = new byte[256];
        while (await session.ReadAsync(buffer, Cancel).AsTask().WaitAsync(TimeSpan.FromSeconds(10), Cancel) > 0)
        {
        }
    }

    /// <summary>What `docker stats --no-stream --format json` printed for a payload (captured once, see the fixture).</summary>
    private static JsonElement CliStats(string payload)
    {
        var line = FakeDockerDaemon.Read("docker-stats-cli.txt").Split('\n').Single(l => l.StartsWith(payload + " ", StringComparison.Ordinal));
        return JsonDocument.Parse(line[(payload.Length + 1)..]).RootElement.Clone();
    }

    // go-units, as the Docker CLI formats sizes: three significant digits in powers of 1000 for IO,
    // four in powers of 1024 for memory, and two decimals for percentages.
    private static string Percent(double value) => value.ToString("F2", CultureInfo.InvariantCulture) + "%";

    private static string DecimalSize(long bytes) => Size(bytes, 1000, ["B", "kB", "MB", "GB", "TB", "PB"], 3);

    private static string BinarySize(long bytes) => Size(bytes, 1024, ["B", "KiB", "MiB", "GiB", "TiB", "PiB"], 4);

    private static string Size(double size, double unit, string[] names, int digits)
    {
        var index = 0;
        while (size >= unit && index < names.Length - 1)
        {
            size /= unit;
            index++;
        }

        return size.ToString("G" + digits.ToString(CultureInfo.InvariantCulture), CultureInfo.InvariantCulture) + names[index];
    }
}
