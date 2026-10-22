using System.Formats.Tar;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using AgentMate.ServerCore.Docker;
using Microsoft.Extensions.Logging.Abstractions;

namespace AgentMate.ServerCore.Tests.Docker;

/// <summary>
/// The engine calls the file manager (E27) makes, through Docker.DotNet against the fake daemon:
/// execs without a TTY, the archive API's stat, get and put, and helper containers. The stat
/// headers, refusals and exec output are the ones Docker 29.9.1 sent for the same requests.
/// </summary>
public sealed class DockerEngineFilesTests
{
    // Recorded: HEAD /containers/{id}/archive?path=/etc/os-release and ?path=/etc on alpine 3.22.
    private const uint GoSymlink777 = 134218239;
    private const uint GoDir755 = 2147484141;

    private static readonly HelperSpec _helper = new(
        new ImageReference("busybox", null, "sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e"),
        "shop_uploads",
        "/data",
        new Dictionary<string, string> { ["agentmate.files"] = "1", ["agentmate.files.volume"] = "shop_uploads" },
        ["sleep", "2147483647"]);

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private static DockerEngine Engine(FakeDockerDaemon daemon) => new(daemon.Endpoint, NullLogger<DockerEngine>.Instance);

    private static byte[] Tar(params (string Name, string Content)[] files)
    {
        var archive = new MemoryStream();
        using (var writer = new TarWriter(archive, TarEntryFormat.Pax, leaveOpen: true))
        {
            foreach (var (name, content) in files)
            {
                writer.WriteEntry(new PaxTarEntry(TarEntryType.RegularFile, name) { DataStream = new MemoryStream(Encoding.UTF8.GetBytes(content)) });
            }
        }

        return archive.ToArray();
    }

    [Fact]
    public async Task An_exec_without_a_tty_returns_stdout_and_stderr_apart_with_the_exit_code()
    {
        await using var daemon = await FakeDockerDaemon.StartAsync();
        daemon.ExecReplies = (_, _) => new FakeExecReply("out\n"u8.ToArray(), "err\n"u8.ToArray(), 3);
        using var engine = Engine(daemon);

        var result = await engine.RunExecAsync("shop-api-1", ["sh", "-c", "echo out; echo err >&2; exit 3"], "node", TimeSpan.FromSeconds(10), 1024, Cancel);

        Assert.Equal(3, result.ExitCode);
        Assert.Equal("out\n", Encoding.UTF8.GetString(result.Stdout));
        Assert.Equal("err\n", Encoding.UTF8.GetString(result.Stderr));
        Assert.False(result.Truncated);
        var body = JsonNode.Parse(Assert.Single(daemon.ExecBodies))!.AsObject();
        Assert.False(Field(body, "Tty")?.GetValue<bool>() ?? false);
        Assert.False(Field(body, "AttachStdin")?.GetValue<bool>() ?? false);
        Assert.True(Field(body, "AttachStdout")!.GetValue<bool>());
        Assert.True(Field(body, "AttachStderr")!.GetValue<bool>());
        Assert.Equal(["sh", "-c", "echo out; echo err >&2; exit 3"], Field(body, "Cmd")!.AsArray().Select(a => a!.GetValue<string>()));
        Assert.Equal("node", Field(body, "User")!.GetValue<string>());
    }

    [Fact]
    public async Task Binary_output_with_nuls_and_newlines_comes_back_byte_for_byte()
    {
        byte[] listing = [.. "612 81a4 1792628316 0 0\nline\nbreak"u8.ToArray(), 0, .. Enumerable.Range(0, 256).Select(i => (byte)i)];
        await using var daemon = await FakeDockerDaemon.StartAsync();
        daemon.ExecReplies = (_, _) => new FakeExecReply(listing, [], 0);
        using var engine = Engine(daemon);

        var result = await engine.RunExecAsync("shop-api-1", ["sh", "-c", "x"], null, TimeSpan.FromSeconds(10), 1 << 20, Cancel);

        Assert.Equal(listing, result.Stdout);
    }

    [Fact]
    public async Task Output_past_the_cap_is_cut_and_marked()
    {
        await using var daemon = await FakeDockerDaemon.StartAsync();
        daemon.ExecReplies = (_, _) => new FakeExecReply(new byte[200_000], [], 0);
        using var engine = Engine(daemon);

        var result = await engine.RunExecAsync("shop-api-1", ["sh", "-c", "yes"], null, TimeSpan.FromSeconds(10), 10_000, Cancel);

        Assert.True(result.Truncated);
        Assert.Equal(10_000, result.Stdout.Length);
    }

    [Fact]
    public async Task A_container_without_a_shell_answers_127_with_the_runtimes_message()
    {
        await using var daemon = await FakeDockerDaemon.StartAsync();
        daemon.ExecReplies = (_, _) => FakeExecReply.Out(FakeDockerDaemon.RecordedOciNoShell, 127);
        using var engine = Engine(daemon);

        var result = await engine.RunExecAsync("toolbox", ["sh", "-c", "true"], null, TimeSpan.FromSeconds(10), 4096, Cancel);

        Assert.Equal(127, result.ExitCode);
        Assert.Contains("executable file not found", Encoding.UTF8.GetString(result.Stdout), StringComparison.Ordinal);
    }

    [Fact]
    public async Task An_exec_in_a_stopped_or_missing_container_is_refused_by_the_engine()
    {
        await using var daemon = await FakeDockerDaemon.StartAsync();
        using var engine = Engine(daemon);

        var stopped = await Assert.ThrowsAsync<DockerRequestException>(() => engine.RunExecAsync("migrate-once", ["true"], null, TimeSpan.FromSeconds(5), 64, Cancel));
        await Assert.ThrowsAsync<DockerNotFoundException>(() => engine.RunExecAsync("nope-gone", ["true"], null, TimeSpan.FromSeconds(5), 64, Cancel));

        Assert.Contains("is not running", stopped.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Stat_reads_the_base64_header_and_converts_gos_mode_to_posix()
    {
        await using var daemon = await FakeDockerDaemon.StartAsync();
        daemon.ArchivePaths["shop-api-1:/etc/os-release"] = (FakeDockerDaemon.Stat("os-release", 21, GoSymlink777, "2026-10-21T19:59:29Z", "/usr/lib/os-release"), []);
        daemon.ArchivePaths["shop-api-1:/etc"] = (FakeDockerDaemon.Stat("etc", 4096, GoDir755, "2026-10-22T00:29:57.483747334Z"), []);
        using var engine = Engine(daemon);

        var link = await engine.StatPathAsync("shop-api-1", "/etc/os-release", Cancel);
        var folder = await engine.StatPathAsync("shop-api-1", "/etc", Cancel);

        Assert.Equal(new PathStat("os-release", 21, 0xA1FF, DateTimeOffset.Parse("2026-10-21T19:59:29Z", System.Globalization.CultureInfo.InvariantCulture).ToUnixTimeMilliseconds(), "/usr/lib/os-release"), link);
        Assert.Equal(0x41ED, folder!.Mode);
        Assert.Null(folder.LinkTarget);
        Assert.Equal(DateTimeOffset.Parse("2026-10-22T00:29:57.483Z", System.Globalization.CultureInfo.InvariantCulture).ToUnixTimeMilliseconds(), folder.MtimeUnixMs);
        Assert.Contains("HEAD /containers/shop-api-1/archive?path=%2Fetc%2Fos-release", daemon.Requests);
    }

    [Theory]
    [InlineData(0x1A4u, 0x81A4)]
    [InlineData((1u << 31) | (1u << 20) | 0x1FFu, 0x43FF)]
    [InlineData((1u << 23) | 0x1EDu, 0x89ED)]
    [InlineData((1u << 22) | 0x1EDu, 0x85ED)]
    [InlineData((1u << 25) | 0x1A4u, 0x11A4)]
    [InlineData((1u << 24) | 0x1EDu, 0xC1ED)]
    [InlineData((1u << 26) | (1u << 21) | 0x1B6u, 0x21B6)]
    [InlineData((1u << 26) | 0x1B0u, 0x61B0)]
    public void Gos_file_modes_map_to_posix_modes(uint goMode, int posix)
    {
        Assert.Equal(posix, DockerMapping.PosixMode(goMode));
    }

    [Fact]
    public async Task Stat_of_nothing_is_null_and_of_a_missing_container_is_not_found()
    {
        await using var daemon = await FakeDockerDaemon.StartAsync();
        using var engine = Engine(daemon);

        Assert.Null(await engine.StatPathAsync("shop-api-1", "/nope", Cancel));
        await Assert.ThrowsAsync<DockerNotFoundException>(() => engine.StatPathAsync("gone-container", "/etc", Cancel));
    }

    [Fact]
    public async Task Get_streams_the_engines_tar()
    {
        var tar = Tar(("./", string.Empty), ("./a.txt", "alpha"));
        await using var daemon = await FakeDockerDaemon.StartAsync();
        daemon.ArchivePaths["shop-api-1:/srv/app/."] = (FakeDockerDaemon.Stat(".", 4096, GoDir755, "2026-10-22T00:29:57Z"), tar);
        using var engine = Engine(daemon);

        await using var stream = await engine.GetArchiveAsync("shop-api-1", "/srv/app/.", Cancel);
        using var copy = new MemoryStream();
        await stream.CopyToAsync(copy, Cancel);

        Assert.Equal(tar, copy.ToArray());
    }

    [Fact]
    public async Task Get_tells_a_missing_path_from_a_missing_container()
    {
        await using var daemon = await FakeDockerDaemon.StartAsync();
        using var engine = Engine(daemon);

        var path = await Assert.ThrowsAsync<DockerPathNotFoundException>(() => engine.GetArchiveAsync("shop-api-1", "/nope", Cancel));
        var container = await Assert.ThrowsAsync<DockerNotFoundException>(() => engine.GetArchiveAsync("gone-container", "/etc", Cancel));

        Assert.Equal("Could not find the file /nope in container shop-api-1", path.Message);
        Assert.Equal("No such container: gone-container", container.Message);
    }

    [Fact]
    public async Task Put_sends_the_tar_to_the_folder_as_it_is_read()
    {
        var tar = Tar(("upload.bin", new string('u', 100_000)));
        await using var daemon = await FakeDockerDaemon.StartAsync();
        daemon.ArchivePaths["shop-api-1:/srv/uploads"] = (FakeDockerDaemon.Stat("uploads", 4096, GoDir755, "2026-10-22T00:29:57Z"), []);
        using var engine = Engine(daemon);

        await engine.PutArchiveAsync("shop-api-1", "/srv/uploads", new MemoryStream(tar), Cancel);

        var put = Assert.Single(daemon.PutArchives);
        Assert.Equal(("shop-api-1", "/srv/uploads"), (put.Container, put.Path));
        Assert.Equal(tar, put.Tar);
    }

    [Fact]
    public async Task A_put_whose_body_fails_reports_the_bodys_own_error_and_keeps_the_engine()
    {
        await using var daemon = await FakeDockerDaemon.StartAsync();
        daemon.ArchivePaths["shop-api-1:/srv/uploads"] = (FakeDockerDaemon.Stat("uploads", 4096, GoDir755, "2026-10-22T00:29:57Z"), []);
        using var engine = Engine(daemon);
        await engine.ListContainersAsync(Cancel);
        var negotiations = daemon.Requests.Count(r => r.StartsWith("GET /version", StringComparison.Ordinal));

        var failed = await Assert.ThrowsAsync<InvalidDataException>(() => engine.PutArchiveAsync("shop-api-1", "/srv/uploads", new FailingBody(70_000), Cancel));
        await engine.ListContainersAsync(Cancel);

        Assert.Equal("The upload ended early.", failed.Message);
        Assert.Equal(negotiations, daemon.Requests.Count(r => r.StartsWith("GET /version", StringComparison.Ordinal)));
    }

    [Fact]
    public async Task Put_into_a_missing_folder_or_onto_a_file_is_refused_in_the_engines_words()
    {
        await using var daemon = await FakeDockerDaemon.StartAsync();
        using var engine = Engine(daemon);

        await Assert.ThrowsAsync<DockerPathNotFoundException>(() => engine.PutArchiveAsync("shop-api-1", "/nope", new MemoryStream(Tar(("x", "x"))), Cancel));
        daemon.PutRefusal = (400, "extraction point is not a directory");
        var file = await Assert.ThrowsAsync<DockerRequestException>(() => engine.PutArchiveAsync("shop-api-1", "/etc/hostname", new MemoryStream(Tar(("x", "x"))), Cancel));

        Assert.Equal("extraction point is not a directory", file.Message);
    }

    [Fact]
    public async Task A_helper_runs_the_pinned_image_without_a_network_with_the_volume_mounted_and_labelled()
    {
        await using var daemon = await FakeDockerDaemon.StartAsync();
        using var engine = Engine(daemon);

        var id = await engine.CreateHelperAsync(_helper, Cancel);

        Assert.True(daemon.Helpers[id]);
        Assert.DoesNotContain(daemon.Requests, r => r.StartsWith("POST /images/create", StringComparison.Ordinal));
        using var body = JsonDocument.Parse(Assert.Single(daemon.CreatedBodies));
        var root = body.RootElement;
        Assert.Equal("busybox@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e", root.GetProperty("Image").GetString());
        Assert.Equal(["sleep", "2147483647"], root.GetProperty("Cmd").EnumerateArray().Select(a => a.GetString()));
        Assert.Equal("1", root.GetProperty("Labels").GetProperty("agentmate.files").GetString());
        Assert.Equal("shop_uploads", root.GetProperty("Labels").GetProperty("agentmate.files.volume").GetString());
        var host = root.GetProperty("HostConfig");
        Assert.Equal("none", host.GetProperty("NetworkMode").GetString());
        var mount = Assert.Single(host.GetProperty("Mounts").EnumerateArray());
        Assert.Equal(("volume", "shop_uploads", "/data"), (mount.GetProperty("Type").GetString(), mount.GetProperty("Source").GetString(), mount.GetProperty("Target").GetString()));
        Assert.Contains("ALL", host.GetProperty("CapDrop").EnumerateArray().Select(c => c.GetString()));
        Assert.Contains("no-new-privileges", host.GetProperty("SecurityOpt").EnumerateArray().Select(c => c.GetString()));
    }

    [Fact]
    public async Task Helpers_stay_out_of_the_container_list_but_the_sweep_still_finds_them()
    {
        await using var daemon = await FakeDockerDaemon.StartAsync();
        using var engine = Engine(daemon);

        var id = await engine.CreateHelperAsync(_helper, Cancel);
        var containers = await engine.ListContainersAsync(Cancel);

        Assert.Equal(["migrate-once", "shop-api-1", "shop-worker-1", "toolbox"], containers.Select(c => c.Summary.Name).Order(StringComparer.Ordinal));
        Assert.Equal([id], await engine.ListLabelledContainersAsync("agentmate.files", Cancel));
    }

    [Fact]
    public async Task A_missing_helper_image_is_pulled_by_digest_first()
    {
        await using var daemon = await FakeDockerDaemon.StartAsync();
        daemon.HelperImagePresent = false;
        using var engine = Engine(daemon);

        var id = await engine.CreateHelperAsync(_helper, Cancel);

        Assert.True(daemon.Helpers[id]);
        Assert.Contains(daemon.Requests, r => r.StartsWith("POST /images/create?fromImage=busybox%40sha256%3Abdf57e528e45", StringComparison.Ordinal));
        Assert.Equal(2, daemon.CreatedBodies.Count);
    }

    [Fact]
    public async Task A_helper_image_that_cannot_be_pulled_says_why()
    {
        await using var daemon = await FakeDockerDaemon.StartAsync();
        daemon.HelperImagePresent = false;
        daemon.PullError = "Get \"https://registry-1.docker.io/v2/\": dial tcp: lookup registry-1.docker.io: no such host";
        using var engine = Engine(daemon);

        var refused = await Assert.ThrowsAsync<DockerRequestException>(() => engine.CreateHelperAsync(_helper, Cancel));

        Assert.Contains("no such host", refused.Message, StringComparison.Ordinal);
        Assert.Empty(daemon.Helpers);
    }

    [Fact]
    public async Task Removing_a_helper_forces_it_and_a_gone_one_is_fine()
    {
        await using var daemon = await FakeDockerDaemon.StartAsync();
        using var engine = Engine(daemon);
        var id = await engine.CreateHelperAsync(_helper, Cancel);

        await engine.RemoveHelperAsync(id, Cancel);
        await engine.RemoveHelperAsync("0123456789ab0123456789ab", Cancel);

        Assert.Empty(daemon.Helpers);
        var remove = Assert.Single(daemon.Requests, r => r.StartsWith($"DELETE /containers/{id}?", StringComparison.Ordinal));
        Assert.Matches("force=(1|true|True)", remove);
    }

    [Fact]
    public async Task Helpers_are_found_again_by_their_label()
    {
        await using var daemon = await FakeDockerDaemon.StartAsync();
        using var engine = Engine(daemon);
        var id = await engine.CreateHelperAsync(_helper, Cancel);

        var labelled = await engine.ListLabelledContainersAsync("agentmate.files", Cancel);

        Assert.Equal([id], labelled);
        var request = Assert.Single(daemon.Requests, r => r.StartsWith("GET /containers/json?", StringComparison.Ordinal));
        Assert.Contains("all=", request, StringComparison.OrdinalIgnoreCase);
        Assert.Contains(Uri.EscapeDataString("agentmate.files"), request, StringComparison.Ordinal);
    }

    /// <summary>A request body that gives some bytes and then fails, as a cut upload does.</summary>
    private sealed class FailingBody(int before) : Stream
    {
        private int _sent;

        public override bool CanRead => true;

        public override bool CanSeek => false;

        public override bool CanWrite => false;

        public override long Length => throw new NotSupportedException();

        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public override int Read(byte[] buffer, int offset, int count) => ReadAsync(buffer.AsMemory(offset, count)).AsTask().GetAwaiter().GetResult();

        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (_sent >= before)
            {
                throw new InvalidDataException("The upload ended early.");
            }

            var count = Math.Min(buffer.Length, before - _sent);
            _sent += count;
            return ValueTask.FromResult(count);
        }

        public override void Flush()
        {
        }

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    private static JsonNode? Field(JsonObject json, string name) =>
        json.FirstOrDefault(p => string.Equals(p.Key, name, StringComparison.OrdinalIgnoreCase)).Value;
}
