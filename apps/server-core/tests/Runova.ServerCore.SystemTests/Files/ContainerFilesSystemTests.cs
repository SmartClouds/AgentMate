using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Logging.Abstractions;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Docker;
using Runova.ServerCore.Files;
using Runova.ServerCore.SystemTests.Nginx;

namespace Runova.ServerCore.SystemTests.Files;

/// <summary>
/// Real Docker for the file manager (E27): an alpine and a debian container (busybox and
/// coreutils), a distroless one with no shell, a stopped one, and a volume behind the pinned
/// busybox helper. Everything is made when a test first asks and removed at the end.
/// </summary>
public sealed class FilesDocker : IAsyncLifetime
{
    public const string Alpine = "alpine:3.22";
    public const string Debian = "debian:stable-slim";
    public const string Distroless = "gcr.io/distroless/python3-debian12";

    private readonly Lock _lock = new();
    private readonly string _prefix = $"am-files-{Guid.NewGuid():N}"[..17];
    private Task<Started>? _start;

    public string AlpineName => _prefix + "-alpine";

    public string DebianName => _prefix + "-debian";

    public string DistrolessName => _prefix + "-distroless";

    public string StoppedName => _prefix + "-stopped";

    public string Volume => _prefix + "-vol";

    public ValueTask InitializeAsync() => ValueTask.CompletedTask;

    public async ValueTask DisposeAsync()
    {
        if (_start is { IsCompletedSuccessfully: true })
        {
            var started = await _start;
            await started.Files.StopAsync(CancellationToken.None);
            started.Files.Dispose();
            started.Engine.Dispose();
            await started.Socket.DisposeAsync();
        }

        if (DockerCli.Unavailable is null)
        {
            await DockerCli.RunAsync(["rm", "-f", AlpineName, DebianName, DistrolessName, StoppedName], TimeSpan.FromMinutes(1), CancellationToken.None);
            var helpers = await DockerCli.RunAsync(["ps", "-aq", "--filter", $"label={VolumeHelpers.VolumeLabel}={Volume}"], TimeSpan.FromMinutes(1), CancellationToken.None);
            foreach (var helper in helpers.Output.Split('\n', StringSplitOptions.RemoveEmptyEntries))
            {
                await DockerCli.RunAsync(["rm", "-f", helper.Trim()], TimeSpan.FromMinutes(1), CancellationToken.None);
            }

            await DockerCli.RunAsync(["volume", "rm", "-f", Volume], TimeSpan.FromMinutes(1), CancellationToken.None);
        }
    }

    internal Task<Started> GetAsync()
    {
        DockerCli.RequireAvailable();
        lock (_lock)
        {
            return _start ??= StartAsync();
        }
    }

    private async Task<Started> StartAsync()
    {
        var minute = TimeSpan.FromMinutes(5);
        var none = CancellationToken.None;
        foreach (var image in new[] { Alpine, Debian, Distroless, $"busybox@{VolumeHelpers.Digest}" })
        {
            await DockerCli.CheckedAsync(["pull", "-q", image], minute, none);
        }

        await DockerCli.CheckedAsync(["run", "-d", "--name", AlpineName, Alpine, "sleep", "100000"], minute, none);
        await DockerCli.CheckedAsync(["run", "-d", "--name", DebianName, Debian, "sleep", "100000"], minute, none);
        await DockerCli.CheckedAsync(["run", "-d", "--name", DistrolessName, Distroless, "-c", "import time; time.sleep(10**9)"], minute, none);
        await DockerCli.CheckedAsync(["create", "--name", StoppedName, Alpine, "sleep", "100000"], minute, none);
        foreach (var container in new[] { AlpineName, DebianName })
        {
            await DockerCli.CheckedAsync(["exec", container, "sh", "-c", "mkdir -p /srv/owned /srv/work && chown 999:999 /srv/owned"], minute, none);
        }

        await DockerCli.CheckedAsync(["volume", "create", Volume], minute, none);
        await DockerCli.CheckedAsync(
            ["run", "--rm", "-v", $"{Volume}:/v", Alpine, "sh", "-c", "mkdir /v/pg && chown 999:999 /v/pg && echo hi > /v/hello.txt && ln -s /etc /v/escape && ln -s ../../../etc/passwd /v/sneaky && ln -s /hello.txt /v/absolute"],
            minute,
            none);

        var socket = EngineSocket.Open();
        var engine = new DockerEngine(socket.Endpoint, NullLogger<DockerEngine>.Instance);
        var files = new ContainerFilesService(engine, TimeProvider.System, NullLogger<ContainerFilesService>.Instance, FileServiceOptions.Default);
        return new Started(socket, engine, files);
    }

    internal sealed record Started(EngineSocket Socket, DockerEngine Engine, ContainerFilesService Files);
}

// Every test passes TestContext.Current.CancellationToken on, through Cancel; the analyzer only
// looks for it written out in the method. The timeouts turn a stuck engine call into a named failure.
#pragma warning disable xUnit1069
public sealed class ContainerFilesSystemTests(FilesDocker docker) : IClassFixture<FilesDocker>
{
    private static readonly Guid _admin = Guid.NewGuid();

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    public static TheoryData<string> WithShell => ["alpine", "debian", "volume"];

    private async Task<(ContainerFilesService Files, FileSessionInfo Session, string Folder)> OpenAsync(string which)
    {
        var files = (await docker.GetAsync()).Files;
        var target = which switch
        {
            "alpine" => new FileTarget(FileTargetKind.Container, docker.AlpineName),
            "debian" => new FileTarget(FileTargetKind.Container, docker.DebianName),
            "distroless" => new FileTarget(FileTargetKind.Container, docker.DistrolessName),
            "stopped" => new FileTarget(FileTargetKind.Container, docker.StoppedName),
            _ => new FileTarget(FileTargetKind.Volume, docker.Volume),
        };
        var session = await files.OpenAsync(target, _admin, Cancel);
        var folder = which switch
        {
            "volume" => $"/t-{Guid.NewGuid():N}"[..11],
            "distroless" or "stopped" => $"/tmp/t-{Guid.NewGuid():N}"[..15],
            _ => $"/srv/work/t-{Guid.NewGuid():N}"[..20],
        };
        await files.MkdirAsync(session.SessionId, _admin, folder, Cancel);
        return (files, session, folder);
    }

    private static Task<FileEntry> UploadAsync(ContainerFilesService files, FileSessionInfo session, string path, byte[] bytes, int? mode = null) =>
        files.UploadAsync(session.SessionId, _admin, path, bytes.Length, mode, new MemoryStream(bytes), Cancel);

    private static async Task<byte[]> DownloadAsync(ContainerFilesService files, FileSessionInfo session, string path)
    {
        await using var download = await files.OpenDownloadAsync(session.SessionId, _admin, path, Cancel);
        using var copy = new MemoryStream();
        await download.Body.CopyToAsync(copy, Cancel);
        Assert.Equal(download.Size, copy.Length);
        return copy.ToArray();
    }

    private static async Task<string[]> NamesAsync(ContainerFilesService files, FileSessionInfo session, string path) =>
        [.. (await files.ListAsync(session.SessionId, _admin, path, Cancel)).Entries.Select(e => e.Name)];

    [Theory(Timeout = 240_000)]
    [MemberData(nameof(WithShell))]
    public async Task With_a_shell_everything_is_possible(string which)
    {
        var (files, session, _) = await OpenAsync(which);

        Assert.Equal(new FileCapabilities(true, true, true, true), session.Capabilities);
        Assert.Null(session.Limitation);
        var root = await files.ListAsync(session.SessionId, _admin, "/", Cancel);
        Assert.False(root.Partial);
        if (which != "volume")
        {
            var etc = Assert.Single(root.Entries, e => e.Name == "etc");
            Assert.Equal((FileEntryKind.Directory, 0x41ED), (etc.Kind, etc.Mode));
            var passwd = await files.StatAsync(session.SessionId, _admin, "/etc/passwd", Cancel);
            Assert.Equal(FileEntryKind.File, passwd!.Kind);
            Assert.Contains("root:", Encoding.UTF8.GetString(await DownloadAsync(files, session, "/etc/passwd")), StringComparison.Ordinal);
        }
    }

    [Theory(Timeout = 240_000)]
    [MemberData(nameof(WithShell))]
    public async Task Names_with_spaces_newlines_and_unicode_go_up_list_and_come_back(string which)
    {
        var (files, session, folder) = await OpenAsync(which);
        string[] names = ["with space.txt", "line\nbreak.txt", "ünïcødé 文件.txt", ".hidden", "-rf", "$(touch pwned)", "back\\slash"];

        foreach (var name in names)
        {
            await UploadAsync(files, session, $"{folder}/{name}", Encoding.UTF8.GetBytes(name));
        }

        var listed = await NamesAsync(files, session, folder);
        Assert.Equal(names.Order(StringComparer.Ordinal), listed.Order(StringComparer.Ordinal));
        foreach (var name in names)
        {
            Assert.Equal(name, Encoding.UTF8.GetString(await DownloadAsync(files, session, $"{folder}/{name}")));
        }
    }

    [Theory(Timeout = 240_000)]
    [MemberData(nameof(WithShell))]
    public async Task Fifty_megabytes_go_up_and_come_down_with_the_same_hash(string which)
    {
        var (files, session, folder) = await OpenAsync(which);
        var bytes = RandomNumberGenerator.GetBytes(50 * 1024 * 1024);

        var entry = await UploadAsync(files, session, $"{folder}/big.bin", bytes);
        var back = await DownloadAsync(files, session, $"{folder}/big.bin");

        Assert.Equal(bytes.Length, entry.Size);
        Assert.Equal(Convert.ToHexString(SHA256.HashData(bytes)), Convert.ToHexString(SHA256.HashData(back)));
        Assert.DoesNotContain(await NamesAsync(files, session, folder), name => name.EndsWith(".part", StringComparison.Ordinal));
    }

    [Theory(Timeout = 240_000)]
    [MemberData(nameof(WithShell))]
    public async Task Rename_chmod_mkdir_and_delete(string which)
    {
        var (files, session, folder) = await OpenAsync(which);
        await UploadAsync(files, session, $"{folder}/a.txt", "A"u8.ToArray());
        await UploadAsync(files, session, $"{folder}/b.txt", "B"u8.ToArray());

        await Assert.ThrowsAsync<FileOperationException>(() => files.RenameAsync(session.SessionId, _admin, $"{folder}/a.txt", $"{folder}/b.txt", Cancel));
        await files.RenameAsync(session.SessionId, _admin, $"{folder}/a.txt", $"{folder}/c.txt", Cancel);
        await files.ChmodAsync(session.SessionId, _admin, $"{folder}/c.txt", 0x1C0, Cancel);
        await files.MkdirAsync(session.SessionId, _admin, $"{folder}/sub", Cancel);
        await UploadAsync(files, session, $"{folder}/sub/x", "x"u8.ToArray());
        var notEmpty = await Assert.ThrowsAsync<FileOperationException>(() => files.RemoveAsync(session.SessionId, _admin, $"{folder}/sub", true, Cancel));
        await files.RemoveAsync(session.SessionId, _admin, $"{folder}/sub/x", false, Cancel);
        await files.RemoveAsync(session.SessionId, _admin, $"{folder}/sub", true, Cancel);
        await files.RemoveAsync(session.SessionId, _admin, $"{folder}/b.txt", false, Cancel);

        Assert.Equal(FileErrorCode.NotEmpty, notEmpty.Code);
        Assert.Equal(["c.txt"], await NamesAsync(files, session, folder));
        Assert.Equal(0x81C0, (await files.StatAsync(session.SessionId, _admin, $"{folder}/c.txt", Cancel))!.Mode);
        Assert.Equal("A", Encoding.UTF8.GetString(await DownloadAsync(files, session, $"{folder}/c.txt")));
    }

    [Theory(Timeout = 240_000)]
    [InlineData("alpine", "/srv/owned")]
    [InlineData("debian", "/srv/owned")]
    [InlineData("volume", "/pg")]
    public async Task An_upload_into_a_folder_owned_by_999_is_owned_by_999(string which, string owned)
    {
        var (files, session, _) = await OpenAsync(which);
        var name = $"{owned}/dump-{Guid.NewGuid():N}"[..(owned.Length + 14)] + ".sql";

        var entry = await UploadAsync(files, session, name, "COPY orders FROM stdin;"u8.ToArray());
        await files.MkdirAsync(session.SessionId, _admin, name + ".d", Cancel);

        Assert.Equal((999, 999), (entry.Uid, entry.Gid));
        var folder = await files.StatAsync(session.SessionId, _admin, name + ".d", Cancel);
        Assert.Equal((999, 999, 0x41ED), (folder!.Uid, folder.Gid, folder.Mode));
    }

    [Theory(Timeout = 240_000)]
    [InlineData("distroless", FileTargetKind.Container)]
    [InlineData("stopped", FileTargetKind.Container)]
    public async Task Without_a_shell_lists_copies_and_makes_folders_but_says_why_the_rest_is_off(string which, FileTargetKind kind)
    {
        var (files, session, folder) = await OpenAsync(which);
        var bytes = RandomNumberGenerator.GetBytes(3 * 1024 * 1024);

        var entry = await UploadAsync(files, session, $"{folder}/blob.bin", bytes);
        var listing = await files.ListAsync(session.SessionId, _admin, "/etc", Cancel);

        Assert.Equal(kind, session.Target.Kind);
        Assert.Equal(new FileCapabilities(false, false, false, false), session.Capabilities);
        Assert.Equal(
            which == "stopped" ? ContainerFilesService.StoppedLimitation : ContainerFilesService.NoShellLimitation,
            session.Limitation);
        Assert.Equal(bytes.Length, entry.Size);
        Assert.Equal(SHA256.HashData(bytes), SHA256.HashData(await DownloadAsync(files, session, $"{folder}/blob.bin")));
        Assert.Contains(listing.Entries, e => e.Name == "passwd" && e.Kind == FileEntryKind.File);
        Assert.Equal(["blob.bin"], await NamesAsync(files, session, folder));
        var refused = await Assert.ThrowsAsync<FileOperationException>(() => files.RemoveAsync(session.SessionId, _admin, $"{folder}/blob.bin", false, Cancel));
        Assert.Equal(FileErrorCode.Unsupported, refused.Code);
    }

    [Fact(Timeout = 240_000)]
    public async Task Nothing_climbs_out_of_a_volume_and_its_links_are_read_from_its_own_root()
    {
        var (files, session, _) = await OpenAsync("volume");

        var climbed = await Assert.ThrowsAsync<FileOperationException>(() => files.ListAsync(session.SessionId, _admin, "/../../etc", Cancel));
        var throughLink = await Assert.ThrowsAsync<FileOperationException>(() => files.ListAsync(session.SessionId, _admin, "/escape", Cancel));
        var relative = await Assert.ThrowsAsync<FileOperationException>(() => files.OpenDownloadAsync(session.SessionId, _admin, "/sneaky", Cancel));
        var upload = await Assert.ThrowsAsync<FileOperationException>(() => UploadAsync(files, session, "/escape/hostname", "x"u8.ToArray()));

        // The helper's /etc is never what a link in the volume reaches: the volume has no /etc.
        Assert.Equal(FileErrorCode.NotFound, climbed.Code);
        Assert.Equal(FileErrorCode.NotFound, throughLink.Code);
        Assert.Equal(FileErrorCode.NotFound, relative.Code);
        Assert.Equal(FileErrorCode.NotFound, upload.Code);
        Assert.Equal("/etc", await files.RealpathAsync(session.SessionId, _admin, "/escape", Cancel));
        Assert.Equal("hi\n", Encoding.UTF8.GetString(await DownloadAsync(files, session, "/absolute")));
        var links = (await files.ListAsync(session.SessionId, _admin, "/", Cancel)).Entries.Where(e => e.Kind == FileEntryKind.Symlink).ToDictionary(e => e.Name);
        Assert.Equal(("/etc", true), (links["escape"].LinkTarget, links["escape"].BrokenLink));
        Assert.Equal(("../../../etc/passwd", true), (links["sneaky"].LinkTarget, links["sneaky"].BrokenLink));
        Assert.False(links["absolute"].BrokenLink);

        // Given an /etc of its own, the same links lead there and only there.
        if (await files.StatAsync(session.SessionId, _admin, "/etc", Cancel) is null)
        {
            await files.MkdirAsync(session.SessionId, _admin, "/etc", Cancel);
        }

        await UploadAsync(files, session, "/etc/passwd", "the volume's own\n"u8.ToArray());
        Assert.Equal("the volume's own\n", Encoding.UTF8.GetString(await DownloadAsync(files, session, "/sneaky")));
        Assert.Contains("passwd", await NamesAsync(files, session, "/escape"));
    }

    [Fact(Timeout = 240_000)]
    public async Task The_helper_is_the_pinned_busybox_without_a_network_and_is_found_by_its_label()
    {
        var started = await docker.GetAsync();
        await OpenAsync("volume");

        var ids = await started.Engine.ListLabelledContainersAsync(VolumeHelpers.Label, Cancel);
        var inspect = await DockerCli.CheckedAsync(
            ["inspect", "--format", "{{.Config.Image}} {{.HostConfig.NetworkMode}} {{index .Config.Labels \"runova.files.volume\"}} {{range .Mounts}}{{.Name}}:{{.Destination}}{{end}}", .. ids],
            TimeSpan.FromMinutes(1),
            Cancel);

        Assert.Contains(
            $"busybox@{VolumeHelpers.Digest} none {docker.Volume} {docker.Volume}:/data",
            inspect.Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(line => line.Trim()));
    }

    [Fact(Timeout = 240_000)]
    public async Task An_upload_cancelled_half_way_leaves_nothing_behind()
    {
        var (files, session, folder) = await OpenAsync("debian");
        using var cancel = CancellationTokenSource.CreateLinkedTokenSource(Cancel);
        var body = new SlowBody(8 * 1024 * 1024, cancel);

        await Assert.ThrowsAnyAsync<Exception>(() => files.UploadAsync(session.SessionId, _admin, $"{folder}/half.iso", 64L * 1024 * 1024, null, body, cancel.Token));

        Assert.Empty(await NamesAsync(files, session, folder));
    }

    /// <summary>Sends some bytes, then cancels the upload, as a client that goes away does.</summary>
    private sealed class SlowBody(int before, CancellationTokenSource cancel) : Stream
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

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (_sent >= before)
            {
                await cancel.CancelAsync();
                await Task.Delay(Timeout.Infinite, cancel.Token);
            }

            var count = Math.Min(buffer.Length, before - _sent);
            buffer.Span[..count].Fill(7);
            _sent += count;
            return count;
        }

        public override void Flush()
        {
        }

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
#pragma warning restore xUnit1069
