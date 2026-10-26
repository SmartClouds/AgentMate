using System.Text;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Docker;
using Runova.ServerCore.Files;

namespace Runova.ServerCore.Tests.Files;

/// <summary>
/// The files service on the pretend engine, whose containers and volumes hold in-memory file
/// trees and whose execs understand exactly the commands the service sends. Capabilities follow
/// the container (running with a shell, stopped, or distroless), uploads land under a .part name
/// and are moved into place, volumes go through one helper per volume that is removed once idle.
/// </summary>
public sealed class ContainerFilesServiceTests : IDisposable
{
    private const string Running = "shop-api-1";
    private const string Stopped = "migrate-once";
    private const string Distroless = InMemoryDockerEngine.DistrolessContainer;
    private const string Uploads = "shop_uploads";
    private const string Database = "shop_db-data";

    private static readonly Guid _maria = Guid.NewGuid();
    private static readonly Guid _omar = Guid.NewGuid();

    private readonly FakeTimeProvider _clock = new(DateTimeOffset.Parse("2026-10-22T09:00:00Z", System.Globalization.CultureInfo.InvariantCulture));
    private readonly InMemoryDockerEngine _engine;
    private readonly ContainerFilesService _files;

    public ContainerFilesServiceTests()
    {
        _engine = new InMemoryDockerEngine(_clock);
        _files = new ContainerFilesService(_engine, _clock, NullLogger<ContainerFilesService>.Instance, FileServiceOptions.Default with { ListingByteCap = 64 * 1024 });
    }

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    public void Dispose() => _files.Dispose();

    private Task<FileSessionInfo> OpenAsync(string container) => _files.OpenAsync(new FileTarget(FileTargetKind.Container, container), _maria, Cancel);

    private Task<FileSessionInfo> OpenVolumeAsync(string volume) => _files.OpenAsync(new FileTarget(FileTargetKind.Volume, volume), _maria, Cancel);

    private Task<FileEntry> UploadAsync(FileSessionInfo session, string path, string content, int? mode = null)
    {
        var bytes = Encoding.UTF8.GetBytes(content);
        return _files.UploadAsync(session.SessionId, _maria, path, bytes.Length, mode, new MemoryStream(bytes), Cancel);
    }

    private async Task<string> ReadAsync(FileSessionInfo session, string path)
    {
        await using var download = await _files.OpenDownloadAsync(session.SessionId, _maria, path, Cancel);
        using var copy = new MemoryStream();
        await download.Body.CopyToAsync(copy, Cancel);
        return Encoding.UTF8.GetString(copy.ToArray());
    }

    private async Task<string[]> NamesAsync(FileSessionInfo session, string path) =>
        [.. (await _files.ListAsync(session.SessionId, _maria, path, Cancel)).Entries.Select(e => e.Name).Order(StringComparer.Ordinal)];

    private static async Task<FileErrorCode> CodeOf(Func<Task> call) => (await Assert.ThrowsAsync<FileOperationException>(call)).Code;

    [Fact]
    public async Task A_running_container_with_a_shell_can_do_everything_and_starts_in_its_working_folder()
    {
        var session = await OpenAsync(Running);

        Assert.Equal(new FileCapabilities(Rename: true, Remove: true, Chmod: true, AtomicUpload: true), session.Capabilities);
        Assert.Null(session.Limitation);
        Assert.Equal("/srv/app", session.Home);
        Assert.Equal("root", session.User);
        Assert.Equal(Running, session.DisplayName);
        Assert.Equal(new FileTarget(FileTargetKind.Container, Running), session.Target);
    }

    [Fact]
    public async Task The_session_names_the_containers_own_user()
    {
        var session = await OpenAsync("monitoring-grafana-1");

        Assert.Equal("472", session.User);
        Assert.Equal("/", session.Home);
    }

    [Fact]
    public async Task A_stopped_container_lists_and_copies_but_says_why_the_rest_is_off()
    {
        var session = await OpenAsync(Stopped);

        Assert.Equal(new FileCapabilities(false, false, false, false), session.Capabilities);
        Assert.Equal("The container is stopped. Start it to rename, delete or change permissions.", session.Limitation);
        Assert.Contains("migrate.js", await NamesAsync(session, "/srv/app"));
        var refused = await Assert.ThrowsAsync<FileOperationException>(() => _files.RenameAsync(session.SessionId, _maria, "/srv/app/migrate.js", "/srv/app/m.js", Cancel));
        Assert.Equal(FileErrorCode.Unsupported, refused.Code);
        Assert.Equal(session.Limitation, refused.Message);
        Assert.Equal(FileErrorCode.Unsupported, await CodeOf(() => _files.RemoveAsync(session.SessionId, _maria, "/srv/app/migrate.js", false, Cancel)));
        Assert.Equal(FileErrorCode.Unsupported, await CodeOf(() => _files.ChmodAsync(session.SessionId, _maria, "/srv/app/migrate.js", 0x1ED, Cancel)));
    }

    [Fact]
    public async Task A_container_without_a_shell_lists_and_copies_but_says_why_the_rest_is_off()
    {
        var session = await OpenAsync(Distroless);

        Assert.Equal(new FileCapabilities(false, false, false, false), session.Capabilities);
        Assert.Equal("This container has no shell, so files can be listed and copied but not renamed, deleted or changed.", session.Limitation);
        Assert.Contains("config.yml", await NamesAsync(session, "/etc/cloudflared"));
    }

    [Fact]
    public async Task Without_a_shell_uploads_downloads_and_new_folders_still_work()
    {
        foreach (var container in new[] { Stopped, Distroless })
        {
            var session = await OpenAsync(container);

            var uploaded = await UploadAsync(session, "/tmp/notes.txt", "written in place");
            await _files.MkdirAsync(session.SessionId, _maria, "/tmp/new folder", Cancel);

            Assert.Equal(16, uploaded.Size);
            Assert.Equal("written in place", await ReadAsync(session, "/tmp/notes.txt"));
            Assert.Contains("new folder", await NamesAsync(session, "/tmp"));
            Assert.DoesNotContain(_engine.FileLog, line => line.StartsWith($"exec {container}", StringComparison.Ordinal) && line.Contains("mv", StringComparison.Ordinal));
        }
    }

    [Fact]
    public async Task Listing_shows_modes_owners_dotfiles_and_links()
    {
        var session = await OpenAsync(Running);

        var listing = await _files.ListAsync(session.SessionId, _maria, "/srv/app", Cancel);

        Assert.False(listing.Partial);
        Assert.Equal("/srv/app", listing.Path);
        var package = Assert.Single(listing.Entries, e => e.Name == "package.json");
        Assert.Equal(FileEntryKind.File, package.Kind);
        Assert.Equal(0x81A4, package.Mode);
        Assert.Equal(1000, package.Uid);
        Assert.Contains(listing.Entries, e => e.Name == ".npmrc");
        Assert.Equal(FileEntryKind.Directory, Assert.Single(listing.Entries, e => e.Name == "node_modules").Kind);
        var link = Assert.Single(listing.Entries, e => e.Name == "uploads");
        Assert.Equal((FileEntryKind.Symlink, "/srv/uploads", true, false), (link.Kind, link.LinkTarget, link.LinkIsDirectory, link.BrokenLink));
    }

    [Theory]
    [InlineData("with space.txt")]
    [InlineData("line\nbreak.txt")]
    [InlineData("ünïcødé 文件.txt")]
    [InlineData(".env.local")]
    [InlineData("-rf")]
    [InlineData("$(touch pwned)")]
    public async Task Any_name_goes_up_and_comes_back_listed(string name)
    {
        var session = await OpenAsync(Running);

        await UploadAsync(session, "/srv/app/" + name, "x");

        Assert.Contains(name, await NamesAsync(session, "/srv/app"));
        Assert.DoesNotContain("pwned", await NamesAsync(session, "/srv/app"));
        Assert.Equal("x", await ReadAsync(session, "/srv/app/" + name));
    }

    [Fact]
    public async Task Listing_a_stopped_container_reads_the_archive_one_level_deep()
    {
        var session = await OpenAsync(Stopped);

        var listing = await _files.ListAsync(session.SessionId, _maria, "/srv/app", Cancel);

        Assert.False(listing.Partial);
        Assert.Equal(["migrate.js", "node_modules", "package.json"], listing.Entries.Select(e => e.Name).Where(n => !n.StartsWith('.')).Order(StringComparer.Ordinal));
        var package = Assert.Single(listing.Entries, e => e.Name == "package.json");
        Assert.Equal((FileEntryKind.File, 0x81A4, 1000), (package.Kind, package.Mode, package.Uid));
        Assert.True(package.Size > 0);
        Assert.Equal(FileEntryKind.Directory, Assert.Single(listing.Entries, e => e.Name == "node_modules").Kind);
    }

    [Fact]
    public async Task An_archive_listing_past_the_byte_cap_is_partial()
    {
        var session = await OpenAsync(Stopped);
        for (var i = 0; i < 5; i++)
        {
            await _files.UploadAsync(session.SessionId, _maria, $"/srv/app/blob-{i}.bin", 40_000, null, new MemoryStream(new byte[40_000]), Cancel);
        }

        var listing = await _files.ListAsync(session.SessionId, _maria, "/srv/app", Cancel);

        Assert.True(listing.Partial);
        Assert.NotEmpty(listing.Entries);
    }

    [Fact]
    public async Task Listing_refuses_what_is_not_a_folder()
    {
        foreach (var container in new[] { Running, Stopped })
        {
            var session = await OpenAsync(container);

            Assert.Equal(FileErrorCode.NotFound, await CodeOf(() => _files.ListAsync(session.SessionId, _maria, "/no/such/folder", Cancel)));
            Assert.Equal(FileErrorCode.NotDirectory, await CodeOf(() => _files.ListAsync(session.SessionId, _maria, "/srv/app/package.json", Cancel)));
            Assert.Equal(FileErrorCode.InvalidInput, await CodeOf(() => _files.ListAsync(session.SessionId, _maria, "srv/app", Cancel)));
        }
    }

    [Fact]
    public async Task An_upload_lands_under_a_part_name_and_is_moved_into_place_owned_like_its_folder()
    {
        var session = await OpenVolumeAsync(Database);

        var entry = await UploadAsync(session, "/dump.sql", "COPY public.orders FROM stdin;");

        var put = Assert.Single(_engine.FileLog, line => line.StartsWith("put ", StringComparison.Ordinal));
        Assert.Matches(@"^put \S+ /data \.dump\.sql\.runova-[0-9a-f]{8}\.part 999:999$", put);
        var move = Assert.Single(_engine.FileLog, line => line.Contains(" mv ", StringComparison.Ordinal));
        Assert.Matches(@" mv -f -- /data/\.dump\.sql\.runova-[0-9a-f]{8}\.part /data/dump\.sql$", move);
        Assert.Equal((999, 999, 0x81A4), (entry.Uid, entry.Gid, entry.Mode));
        Assert.Equal("dump.sql", entry.Name);
        Assert.DoesNotContain(await NamesAsync(session, "/"), name => name.EndsWith(".part", StringComparison.Ordinal));
        Assert.Equal("COPY public.orders FROM stdin;", await ReadAsync(session, "/dump.sql"));
    }

    [Fact]
    public async Task An_upload_keeps_the_mode_of_the_file_it_replaces_unless_asked_otherwise()
    {
        var session = await OpenAsync(Running);
        await UploadAsync(session, "/srv/app/.env", "A=1", mode: 0x180);

        var replaced = await UploadAsync(session, "/srv/app/.env", "A=2");
        var fresh = await UploadAsync(session, "/srv/app/run.sh", "#!/bin/sh");
        var asked = await UploadAsync(session, "/srv/app/run.sh", "#!/bin/sh", mode: 0x1ED);

        Assert.Equal(0x8180, replaced.Mode);
        Assert.Equal(0x81A4, fresh.Mode);
        Assert.Equal(0x81ED, asked.Mode);
        Assert.Equal("A=2", await ReadAsync(session, "/srv/app/.env"));
    }

    [Fact]
    public async Task An_upload_through_a_link_writes_the_file_it_points_at()
    {
        var session = await OpenVolumeAsync(Uploads);

        await UploadAsync(session, "/latest-invoice.pdf", "new invoice");

        Assert.Equal("new invoice", await ReadAsync(session, "/invoices/2026-09.pdf"));
        var link = Assert.Single((await _files.ListAsync(session.SessionId, _maria, "/", Cancel)).Entries, e => e.Name == "latest-invoice.pdf");
        Assert.Equal(FileEntryKind.Symlink, link.Kind);
    }

    [Fact]
    public async Task An_upload_onto_a_folder_or_into_nothing_is_refused()
    {
        var session = await OpenAsync(Running);

        Assert.Equal(FileErrorCode.IsDirectory, await CodeOf(() => UploadAsync(session, "/srv/app/node_modules", "x")));
        Assert.Equal(FileErrorCode.NotFound, await CodeOf(() => UploadAsync(session, "/srv/missing/x.txt", "x")));
        Assert.Equal(FileErrorCode.NotDirectory, await CodeOf(() => UploadAsync(session, "/srv/app/package.json/x.txt", "x")));
        Assert.Equal(FileErrorCode.InvalidInput, await CodeOf(() => UploadAsync(session, "/", "x")));
    }

    [Fact]
    public async Task An_upload_cut_short_leaves_no_part_file_and_the_old_file_as_it_was()
    {
        var session = await OpenAsync(Running);
        await UploadAsync(session, "/srv/app/config.json", "{\"old\":true}");

        var refused = await CodeOf(() => _files.UploadAsync(session.SessionId, _maria, "/srv/app/config.json", 1000, null, new MemoryStream(new byte[400]), Cancel));

        Assert.Equal(FileErrorCode.InvalidInput, refused);
        Assert.Equal("{\"old\":true}", await ReadAsync(session, "/srv/app/config.json"));
        Assert.DoesNotContain(await NamesAsync(session, "/srv/app"), name => name.EndsWith(".part", StringComparison.Ordinal));
    }

    [Fact]
    public async Task An_upload_the_client_abandons_leaves_no_part_file()
    {
        var session = await OpenAsync(Running);
        using var abandon = new CancellationTokenSource();
        var body = new AbandoningStream(4096, abandon);

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => _files.UploadAsync(session.SessionId, _maria, "/srv/app/big.iso", 1_000_000, null, body, abandon.Token));

        Assert.DoesNotContain(await NamesAsync(session, "/srv/app"), name => name.Contains("big.iso", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Rename_moves_and_refuses_a_name_that_is_taken()
    {
        var session = await OpenAsync(Running);
        await UploadAsync(session, "/srv/app/a.txt", "A");
        await UploadAsync(session, "/srv/app/b.txt", "B");

        Assert.Equal(FileErrorCode.Exists, await CodeOf(() => _files.RenameAsync(session.SessionId, _maria, "/srv/app/a.txt", "/srv/app/b.txt", Cancel)));
        await _files.RenameAsync(session.SessionId, _maria, "/srv/app/a.txt", "/srv/app/c.txt", Cancel);

        Assert.Equal("B", await ReadAsync(session, "/srv/app/b.txt"));
        Assert.Equal("A", await ReadAsync(session, "/srv/app/c.txt"));
        Assert.Null(await _files.StatAsync(session.SessionId, _maria, "/srv/app/a.txt", Cancel));
        Assert.Equal(FileErrorCode.NotFound, await CodeOf(() => _files.RenameAsync(session.SessionId, _maria, "/srv/app/a.txt", "/srv/app/d.txt", Cancel)));
    }

    [Fact]
    public async Task Remove_unlinks_files_and_links_and_only_empty_folders()
    {
        var session = await OpenVolumeAsync(Uploads);
        await _files.MkdirAsync(session.SessionId, _maria, "/empty", Cancel);

        await _files.RemoveAsync(session.SessionId, _maria, "/latest-invoice.pdf", false, Cancel);
        await _files.RemoveAsync(session.SessionId, _maria, "/empty", true, Cancel);

        Assert.Equal(FileErrorCode.NotEmpty, await CodeOf(() => _files.RemoveAsync(session.SessionId, _maria, "/invoices", true, Cancel)));
        Assert.Equal(FileErrorCode.IsDirectory, await CodeOf(() => _files.RemoveAsync(session.SessionId, _maria, "/invoices", false, Cancel)));
        Assert.Equal(FileErrorCode.InvalidInput, await CodeOf(() => _files.RemoveAsync(session.SessionId, _maria, "/", true, Cancel)));
        var names = await NamesAsync(session, "/");
        Assert.DoesNotContain("latest-invoice.pdf", names);
        Assert.DoesNotContain("empty", names);
        Assert.Contains("2026-09.pdf", await NamesAsync(session, "/invoices"));
    }

    [Fact]
    public async Task Chmod_sets_the_permission_bits()
    {
        var session = await OpenAsync(Running);
        await UploadAsync(session, "/srv/app/run.sh", "#!/bin/sh");

        await _files.ChmodAsync(session.SessionId, _maria, "/srv/app/run.sh", 0x1ED, Cancel);

        Assert.Equal(0x81ED, (await _files.StatAsync(session.SessionId, _maria, "/srv/app/run.sh", Cancel))!.Mode);
        Assert.Contains(_engine.FileLog, line => line.EndsWith(" chmod 0755 -- /srv/app/run.sh", StringComparison.Ordinal));
        Assert.Equal(FileErrorCode.InvalidInput, await CodeOf(() => _files.ChmodAsync(session.SessionId, _maria, "/srv/app/run.sh", 0x10000, Cancel)));
        Assert.Equal(FileErrorCode.NotFound, await CodeOf(() => _files.ChmodAsync(session.SessionId, _maria, "/srv/app/nothing", 0x1ED, Cancel)));
    }

    [Fact]
    public async Task Mkdir_makes_a_folder_owned_like_its_parent()
    {
        var session = await OpenVolumeAsync(Database);

        await _files.MkdirAsync(session.SessionId, _maria, "/restore", Cancel);

        var made = await _files.StatAsync(session.SessionId, _maria, "/restore", Cancel);
        Assert.Equal((FileEntryKind.Directory, 999, 999, 0x41ED), (made!.Kind, made.Uid, made.Gid, made.Mode));
        Assert.Equal(FileErrorCode.Exists, await CodeOf(() => _files.MkdirAsync(session.SessionId, _maria, "/restore", Cancel)));
        Assert.Equal(FileErrorCode.NotFound, await CodeOf(() => _files.MkdirAsync(session.SessionId, _maria, "/no/parent", Cancel)));
    }

    [Fact]
    public async Task Stat_shows_a_link_as_itself_and_answers_null_for_nothing()
    {
        foreach (var session in new[] { await OpenVolumeAsync(Uploads), await OpenAsync(Stopped) })
        {
            var folder = session.Target.Kind == FileTargetKind.Volume ? "/" : "/srv/uploads/";
            var link = await _files.StatAsync(session.SessionId, _maria, folder + "latest-invoice.pdf", Cancel);
            var real = await _files.StatAsync(session.SessionId, _maria, folder + "invoices/2026-09.pdf", Cancel);
            var broken = await _files.StatAsync(session.SessionId, _maria, folder + "old-banner.png", Cancel);

            Assert.Equal((FileEntryKind.Symlink, "invoices/2026-09.pdf", "latest-invoice.pdf"), (link!.Kind, link.LinkTarget, link.Name));
            Assert.Equal(FileEntryKind.File, real!.Kind);
            Assert.True(real.Size > 0);
            Assert.Equal(FileEntryKind.Symlink, broken!.Kind);
            Assert.Null(await _files.StatAsync(session.SessionId, _maria, folder + "nothing-here", Cancel));
            Assert.Null(await _files.StatAsync(session.SessionId, _maria, folder + "no/such/folder", Cancel));
        }
    }

    [Fact]
    public async Task With_a_shell_stat_and_listing_say_where_a_link_leads()
    {
        var session = await OpenVolumeAsync(Uploads);
        _engine.PlantLink(Uploads, "/loop-a", "loop-b");
        _engine.PlantLink(Uploads, "/loop-b", "loop-a");

        var broken = await _files.StatAsync(session.SessionId, _maria, "/old-banner.png", Cancel);
        var file = await _files.StatAsync(session.SessionId, _maria, "/latest-invoice.pdf", Cancel);
        var loop = Assert.Single((await _files.ListAsync(session.SessionId, _maria, "/", Cancel)).Entries, e => e.Name == "loop-a");

        Assert.True(broken!.BrokenLink);
        Assert.False(file!.BrokenLink);
        Assert.False(file.LinkIsDirectory);
        Assert.True(loop.BrokenLink);
    }

    [Fact]
    public async Task Stat_of_the_root_is_a_folder()
    {
        var session = await OpenVolumeAsync(Uploads);

        var root = await _files.StatAsync(session.SessionId, _maria, "/", Cancel);

        Assert.Equal(FileEntryKind.Directory, root!.Kind);
        Assert.Equal("/", root.Name);
    }

    [Fact]
    public async Task Download_streams_a_file_with_its_size_and_time_and_refuses_folders()
    {
        var session = await OpenAsync(Running);
        var uploaded = await UploadAsync(session, "/srv/app/report.csv", "a,b\n1,2\n");

        await using (var download = await _files.OpenDownloadAsync(session.SessionId, _maria, "/srv/app/report.csv", Cancel))
        {
            Assert.Equal(8, download.Size);
            Assert.Equal(uploaded.MtimeUnixMs, download.MtimeUnixMs);
        }

        Assert.Equal(FileErrorCode.IsDirectory, await CodeOf(() => _files.OpenDownloadAsync(session.SessionId, _maria, "/srv/app/node_modules", Cancel)));
        Assert.Equal(FileErrorCode.NotFound, await CodeOf(() => _files.OpenDownloadAsync(session.SessionId, _maria, "/srv/app/nothing", Cancel)));
    }

    [Fact]
    public async Task Download_reads_through_a_link_without_a_shell_too()
    {
        var session = await OpenAsync(Stopped);

        Assert.StartsWith("%PDF", await ReadAsync(session, "/srv/uploads/latest-invoice.pdf"), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Realpath_collapses_dots_and_resolves_links()
    {
        var running = await OpenAsync(Running);
        var stopped = await OpenAsync(Stopped);

        Assert.Equal("/srv", await _files.RealpathAsync(running.SessionId, _maria, "/srv/app/..", Cancel));
        Assert.Equal("/srv/uploads", await _files.RealpathAsync(running.SessionId, _maria, "/srv/app/uploads", Cancel));
        Assert.Equal("/srv/uploads/not-yet", await _files.RealpathAsync(running.SessionId, _maria, "/srv/app/uploads/not-yet", Cancel));
        Assert.Equal("/srv", await _files.RealpathAsync(stopped.SessionId, _maria, "/srv/app/..", Cancel));
    }

    [Fact]
    public async Task A_volume_has_every_capability_through_one_helper_shared_by_its_sessions()
    {
        var first = await OpenVolumeAsync(Uploads);
        var second = await OpenVolumeAsync(Uploads);

        Assert.Equal(new FileCapabilities(true, true, true, true), first.Capabilities);
        Assert.Equal(("/", "root", Uploads), (first.Home, first.User, first.DisplayName));
        Assert.Null(first.Limitation);
        Assert.Single(_engine.Helpers);
        Assert.Equal(Uploads, Assert.Single(_engine.Helpers).Volume);
        Assert.Contains("invoices", await NamesAsync(second, "/"));
        Assert.Contains(_engine.FileLog, line => line.StartsWith("helper-create shop_uploads", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_volume_shows_through_its_containers_too()
    {
        var volume = await OpenVolumeAsync(Uploads);
        var container = await OpenAsync(Running);

        await UploadAsync(volume, "/hello.txt", "from the volume");

        Assert.Equal("from the volume", await ReadAsync(container, "/srv/uploads/hello.txt"));
    }

    [Theory]
    [InlineData("/../../etc")]
    [InlineData("/../..")]
    public async Task Climbing_out_of_a_volume_stays_in_it(string path)
    {
        var session = await OpenVolumeAsync(Uploads);

        var listing = path.EndsWith("etc", StringComparison.Ordinal)
            ? await CodeOf(() => _files.ListAsync(session.SessionId, _maria, path, Cancel)).ContinueWith(t => (object)t.Result, TaskScheduler.Default)
            : await _files.ListAsync(session.SessionId, _maria, path, Cancel);

        if (listing is FileListing root)
        {
            Assert.Equal("/", root.Path);
            Assert.Contains(root.Entries, e => e.Name == "invoices");
        }
        else
        {
            Assert.Equal(FileErrorCode.NotFound, listing);
        }
    }

    [Fact]
    public async Task A_link_in_a_volume_resolves_from_the_volumes_own_root_and_never_reaches_the_helper()
    {
        var session = await OpenVolumeAsync(Uploads);
        _engine.PlantLink(Uploads, "/escape", "/etc");
        _engine.PlantLink(Uploads, "/sneaky", "../../../etc/passwd");

        // The helper has an /etc of its own; the volume does not, so both links lead nowhere.
        Assert.Equal(FileErrorCode.NotFound, await CodeOf(() => _files.ListAsync(session.SessionId, _maria, "/escape", Cancel)));
        Assert.Equal(FileErrorCode.NotFound, await CodeOf(() => _files.OpenDownloadAsync(session.SessionId, _maria, "/sneaky", Cancel)));
        Assert.Equal(FileErrorCode.NotFound, await CodeOf(() => UploadAsync(session, "/escape/hostname", "x")));
        Assert.Equal(FileErrorCode.NotFound, await CodeOf(() => _files.ChmodAsync(session.SessionId, _maria, "/sneaky", 0x1FF, Cancel)));
        Assert.Equal(FileErrorCode.NotFound, await CodeOf(() => _files.MkdirAsync(session.SessionId, _maria, "/escape/x", Cancel)));
        Assert.Equal("/etc", await _files.RealpathAsync(session.SessionId, _maria, "/escape", Cancel));
        Assert.Null(await _files.StatAsync(session.SessionId, _maria, "/escape/passwd", Cancel));
        var root = (await _files.ListAsync(session.SessionId, _maria, "/", Cancel)).Entries;
        Assert.True(Assert.Single(root, e => e.Name == "escape").BrokenLink);
        Assert.True(Assert.Single(root, e => e.Name == "sneaky").BrokenLink);

        // Once the volume has an /etc of its own, that is where they lead.
        _engine.PlantEntry(FileTargetKind.Volume, Uploads, "/etc/passwd", 'f', content: "the volume's own"u8.ToArray());

        Assert.Equal(["passwd"], await NamesAsync(session, "/escape"));
        Assert.Equal("the volume's own", await ReadAsync(session, "/sneaky"));
        await UploadAsync(session, "/escape/hostname", "written into the volume");
        Assert.Equal("written into the volume", await ReadAsync(session, "/etc/hostname"));
        Assert.True(Assert.Single((await _files.ListAsync(session.SessionId, _maria, "/", Cancel)).Entries, e => e.Name == "escape").LinkIsDirectory);
        // The link itself is the volume's own, so it can be removed.
        await _files.RemoveAsync(session.SessionId, _maria, "/escape", false, Cancel);
        Assert.Contains("passwd", await NamesAsync(session, "/etc"));
    }

    [Fact]
    public async Task Absolute_links_in_a_volume_are_read_as_volume_paths()
    {
        var session = await OpenVolumeAsync(Uploads);
        _engine.PlantLink(Uploads, "/abs-file", "/invoices/2026-09.pdf");
        _engine.PlantLink(Uploads, "/abs-dir", "/invoices");
        _engine.PlantLink(Uploads, "/abs-dir/../chain", "/abs-dir/2026-08.pdf");

        var root = (await _files.ListAsync(session.SessionId, _maria, "/", Cancel)).Entries;

        Assert.Equal((false, false), (Assert.Single(root, e => e.Name == "abs-file").LinkIsDirectory, Assert.Single(root, e => e.Name == "abs-file").BrokenLink));
        Assert.True(Assert.Single(root, e => e.Name == "abs-dir").LinkIsDirectory);
        Assert.False(Assert.Single(root, e => e.Name == "chain").BrokenLink);
        Assert.StartsWith("%PDF", await ReadAsync(session, "/abs-file"), StringComparison.Ordinal);
        Assert.StartsWith("%PDF", await ReadAsync(session, "/chain"), StringComparison.Ordinal);
        Assert.Contains("2026-09.pdf", await NamesAsync(session, "/abs-dir"));
        Assert.Equal("/invoices/2026-09.pdf", await _files.RealpathAsync(session.SessionId, _maria, "/abs-file", Cancel));
        await _files.RenameAsync(session.SessionId, _maria, "/abs-dir/2026-08.pdf", "/abs-dir/august.pdf", Cancel);
        Assert.Contains("august.pdf", await NamesAsync(session, "/invoices"));
        await _files.ChmodAsync(session.SessionId, _maria, "/abs-file", 0x180, Cancel);
        Assert.Equal(0x8180, (await _files.StatAsync(session.SessionId, _maria, "/invoices/2026-09.pdf", Cancel))!.Mode);
    }

    [Fact]
    public async Task A_session_is_its_openers_alone()
    {
        var session = await OpenAsync(Running);

        Assert.Equal(FileErrorCode.SessionGone, await CodeOf(() => _files.ListAsync(session.SessionId, _omar, "/", Cancel)));
        Assert.Equal(FileErrorCode.SessionGone, await CodeOf(() => _files.ListAsync(Guid.NewGuid(), _maria, "/", Cancel)));
        Assert.Equal(FileErrorCode.SessionGone, await CodeOf(() => _files.CloseAsync(session.SessionId, _omar, Cancel)));
        Assert.Contains("package.json", await NamesAsync(session, "/srv/app"));
    }

    [Fact]
    public async Task A_closed_session_is_gone()
    {
        var session = await OpenAsync(Running);

        await _files.CloseAsync(session.SessionId, _maria, Cancel);

        Assert.Equal(FileErrorCode.SessionGone, await CodeOf(() => _files.ListAsync(session.SessionId, _maria, "/", Cancel)));
    }

    [Fact]
    public async Task A_session_left_alone_for_15_minutes_expires_and_use_keeps_it_alive()
    {
        var idle = await OpenAsync(Running);
        var busy = await OpenAsync(Running);

        _clock.Advance(TimeSpan.FromMinutes(10));
        await _files.ListAsync(busy.SessionId, _maria, "/", Cancel);
        _clock.Advance(TimeSpan.FromMinutes(6));
        await _files.SweepIdleAsync(Cancel);

        Assert.Equal(FileErrorCode.SessionGone, await CodeOf(() => _files.ListAsync(idle.SessionId, _maria, "/", Cancel)));
        Assert.NotEmpty(await NamesAsync(busy, "/"));
    }

    [Fact]
    public async Task A_helper_is_removed_5_minutes_after_its_last_session_ends()
    {
        var first = await OpenVolumeAsync(Uploads);
        var second = await OpenVolumeAsync(Uploads);

        await _files.CloseAsync(first.SessionId, _maria, Cancel);
        _clock.Advance(TimeSpan.FromMinutes(6));
        await _files.SweepIdleAsync(Cancel);
        Assert.Single(_engine.Helpers);

        await _files.CloseAsync(second.SessionId, _maria, Cancel);
        _clock.Advance(TimeSpan.FromMinutes(4));
        await _files.SweepIdleAsync(Cancel);
        Assert.Single(_engine.Helpers);

        _clock.Advance(TimeSpan.FromMinutes(1));
        await _files.SweepIdleAsync(Cancel);
        Assert.Empty(_engine.Helpers);
    }

    [Fact]
    public async Task An_expired_session_releases_its_helper_too()
    {
        await OpenVolumeAsync(Uploads);

        _clock.Advance(TimeSpan.FromMinutes(16));
        await _files.SweepIdleAsync(Cancel);
        _clock.Advance(TimeSpan.FromMinutes(5));
        await _files.SweepIdleAsync(Cancel);

        Assert.Empty(_engine.Helpers);
    }

    [Fact]
    public async Task A_helper_reopened_in_its_idle_time_is_reused()
    {
        var first = await OpenVolumeAsync(Uploads);
        await _files.CloseAsync(first.SessionId, _maria, Cancel);
        _clock.Advance(TimeSpan.FromMinutes(3));

        await OpenVolumeAsync(Uploads);
        _clock.Advance(TimeSpan.FromMinutes(3));
        await _files.SweepIdleAsync(Cancel);

        Assert.Single(_engine.Helpers);
        Assert.Single(_engine.FileLog, line => line.StartsWith("helper-create", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Helpers_left_by_an_earlier_core_are_swept_at_start_and_ones_in_use_are_kept()
    {
        await _engine.CreateHelperAsync(VolumeHelpers.For(Database), Cancel);
        await _engine.CreateHelperAsync(VolumeHelpers.For("monitoring_prometheus-data"), Cancel);
        var session = await OpenVolumeAsync(Uploads);

        await _files.SweepLeftoversAsync(Cancel);

        Assert.Equal(Uploads, Assert.Single(_engine.Helpers).Volume);
        Assert.Contains("invoices", await NamesAsync(session, "/"));
    }

    [Fact]
    public async Task A_helper_removed_behind_the_cores_back_is_made_again()
    {
        var session = await OpenVolumeAsync(Uploads);
        await _engine.RemoveHelperAsync(Assert.Single(_engine.Helpers).Id, Cancel);

        Assert.Contains("invoices", await NamesAsync(session, "/"));
        Assert.Single(_engine.Helpers);
    }

    [Fact]
    public async Task A_helper_image_that_cannot_be_pulled_says_the_server_looks_offline()
    {
        _engine.HelperPullError = "Get \"https://registry-1.docker.io/v2/\": dial tcp: lookup registry-1.docker.io on 127.0.0.53:53: server misbehaving";

        var refused = await Assert.ThrowsAsync<FileOperationException>(() => OpenVolumeAsync(Uploads));

        Assert.Equal(FileErrorCode.Server, refused.Code);
        Assert.Contains("offline", refused.Message, StringComparison.Ordinal);
        Assert.Contains("busybox", refused.Message, StringComparison.Ordinal);
        Assert.Empty(_engine.Helpers);
    }

    [Fact]
    public async Task A_target_that_is_not_there_is_gone()
    {
        Assert.Equal(FileErrorCode.TargetGone, await CodeOf(() => OpenAsync("no-such-container")));
        Assert.Equal(FileErrorCode.TargetGone, await CodeOf(() => OpenVolumeAsync("no-such-volume")));
        Assert.Equal(FileErrorCode.InvalidInput, await CodeOf(() => OpenAsync("bad name!")));
        Assert.Equal(FileErrorCode.InvalidInput, await CodeOf(() => _files.OpenAsync(new FileTarget((FileTargetKind)7, "x"), _maria, Cancel)));
    }

    [Fact]
    public async Task A_container_removed_while_open_ends_its_session()
    {
        var session = await OpenAsync("toolbox");
        await _engine.RemoveContainerAsync("toolbox", removeVolumes: false, force: true, Cancel);

        Assert.Equal(FileErrorCode.TargetGone, await CodeOf(() => _files.ListAsync(session.SessionId, _maria, "/", Cancel)));
        Assert.Equal(FileErrorCode.SessionGone, await CodeOf(() => _files.ListAsync(session.SessionId, _maria, "/", Cancel)));
    }

    [Fact]
    public async Task A_container_stopped_while_open_asks_for_the_folder_to_be_opened_again()
    {
        var session = await OpenAsync("toolbox");
        await _engine.StopContainerAsync("toolbox", null, Cancel);

        Assert.Equal(FileErrorCode.SessionGone, await CodeOf(() => _files.RenameAsync(session.SessionId, _maria, "/srv/notes.txt", "/srv/n.txt", Cancel)));
        var reopened = await OpenAsync("toolbox");
        Assert.False(reopened.Capabilities.Rename);
    }

    [Fact]
    public async Task Closing_a_users_sessions_ends_them_all()
    {
        await OpenAsync(Running);
        await OpenVolumeAsync(Uploads);

        _files.CloseAllFor(_maria);
        _clock.Advance(TimeSpan.FromMinutes(5));
        await _files.SweepIdleAsync(Cancel);

        Assert.Empty(_engine.Helpers);
    }

    /// <summary>A request body whose client goes away part of the way through.</summary>
    private sealed class AbandoningStream(int before, CancellationTokenSource abandon) : Stream
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

        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (_sent >= before)
            {
                abandon.Cancel();
                cancellationToken.ThrowIfCancellationRequested();
            }

            var count = Math.Min(buffer.Length, before - _sent);
            buffer.Span[..count].Fill((byte)'z');
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
}
