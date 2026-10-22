using System.Formats.Tar;
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using AgentMate.ServerCore.Backups;
using AgentMate.ServerCore.Contracts;
using AgentMate.ServerCore.Data;
using AgentMate.ServerCore.Hosting;

namespace AgentMate.ServerCore.Tests.Backups;

/// <summary>
/// The whole server in one archive (E28): the core's state laid out as E15's restore expects it,
/// and under server/ every volume (copied live), the images no registry can give back, the core's
/// config and a snapshot of what ran, the firewall and the addresses.
/// </summary>
public sealed class FullBackupComposerTests : IAsyncLifetime
{
    private readonly string _root = Directory.CreateTempSubdirectory("am-full-").FullName;
    private readonly FakeBackupDocker _docker = new();
    private readonly FakeServerState _state = new();
    private string Data => Path.Combine(_root, "data");

    private string Work => Path.Combine(_root, "work");

    private string Config => Path.Combine(_root, "core.json");

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        Directory.CreateDirectory(Path.Combine(Data, "stacks", "shop"));
        Directory.CreateDirectory(Path.Combine(Data, "keys"));
        await File.WriteAllTextAsync(Path.Combine(Data, "stacks", "shop", "compose.yaml"), "services: {}", Cancel);
        await File.WriteAllTextAsync(Path.Combine(Data, "keys", "key-1.xml"), "<key/>", Cancel);
        await CoreDatabase.PrepareAsync(CoreDatabase.PathIn(Data), Cancel);
        await File.WriteAllTextAsync(Config, "{\"Core\":{}}", Cancel);
        Directory.CreateDirectory(Work);
    }

    public ValueTask DisposeAsync()
    {
        CoreDatabase.ReleasePool(CoreDatabase.PathIn(Data));
        TestFolders.Delete(_root);
        return ValueTask.CompletedTask;
    }

    private FullBackupComposer Composer(long freeBytes = long.MaxValue) =>
        new(new CoreDirectories(Data), _docker, _state, new FullBackupOptions(Config, "web-1", _ => freeBytes));

    private static async Task<Dictionary<string, byte[]>> EntriesAsync(byte[] archive)
    {
        var entries = new Dictionary<string, byte[]>(StringComparer.Ordinal);
        await using var gzip = new GZipStream(new MemoryStream(archive), CompressionMode.Decompress);
        await using var tar = new TarReader(gzip);
        while (await tar.GetNextEntryAsync(copyData: true, Cancel) is { } entry)
        {
            var bytes = new MemoryStream();
            if (entry.DataStream is { } data)
            {
                await data.CopyToAsync(bytes, Cancel);
            }

            entries[entry.Name] = bytes.ToArray();
        }

        return entries;
    }

    private async Task<(byte[] Archive, FullBackupResult Result)> WriteAsync(FullBackupComposer? composer = null)
    {
        using var output = new MemoryStream();
        var result = await (composer ?? Composer()).WriteAsync(output, Work, 42, Cancel);
        return (output.ToArray(), result);
    }

    [Fact]
    public async Task The_core_volumes_unpullable_images_and_config_are_all_in_it()
    {
        _docker.AddVolume("shop_db", new() { ["data/base.sql"] = Encoding.UTF8.GetBytes("insert") }, project: "shop");
        _docker.AddVolume("loose", new() { ["notes.txt"] = [1, 2, 3] });
        _docker.Images.Add(new BackupImage("sha256:built", ["shop-api:latest"], []));
        _docker.Images.Add(new BackupImage("sha256:pulled", ["postgres:17"], ["postgres@sha256:abc"]));
        _docker.Images.Add(new BackupImage("sha256:inuse", ["redis:8"], ["redis@sha256:def"]));
        _docker.Containers.Add(new BackupContainer("shop-cache-1", "redis:8", "shop", true, new ContainerSpec([], null, null, null, null, [], [], [], null, null)));

        var (archive, result) = await WriteAsync();
        var entries = await EntriesAsync(archive);

        Assert.Contains(BackupArchive.ManifestName, entries.Keys);
        Assert.Contains(CoreDatabase.FileName, entries.Keys);
        Assert.Contains("stacks/shop/compose.yaml", entries.Keys);
        Assert.Contains("keys/key-1.xml", entries.Keys);
        Assert.Contains("server/volumes/shop_db.tar", entries.Keys);
        Assert.Contains("server/volumes/loose.tar", entries.Keys);
        Assert.Equal(
            ["redis:8", "shop-api:latest"],
            entries.Where(e => e.Key.StartsWith("server/images/", StringComparison.Ordinal)).Select(e => Encoding.UTF8.GetString(e.Value)).Order(StringComparer.Ordinal));
        Assert.Null(Assert.Single(result.Snapshot.Images, image => image.Id == "sha256:pulled").File);
        Assert.Equal("{\"Core\":{}}", Encoding.UTF8.GetString(entries["server/config/core.json"]));
        Assert.Equal(2, result.Snapshot.Volumes.Length);
        Assert.Empty(Directory.EnumerateFileSystemEntries(Work));
    }

    [Fact]
    public async Task The_backup_helper_image_is_left_out_unless_a_container_runs_it_too()
    {
        var helperDigest = "busybox@" + DockerBackupEngine.HelperImage[(DockerBackupEngine.HelperImage.IndexOf('@') + 1)..];
        _docker.Images.Add(new BackupImage("sha256:busybox", ["busybox:1.37"], [helperDigest]));

        var (_, alone) = await WriteAsync();
        _docker.Containers.Add(new BackupContainer("keeper", "busybox:1.37", null, true, new ContainerSpec([], null, null, null, null, [], [], [], null, null)));
        var (archive, used) = await WriteAsync();

        Assert.Empty(alone.Snapshot.Images);
        Assert.Equal("busybox:1.37", Encoding.UTF8.GetString(Assert.Single(await EntriesAsync(archive), e => e.Key.StartsWith("server/images/", StringComparison.Ordinal)).Value));
        Assert.NotNull(Assert.Single(used.Snapshot.Images).File);
    }

    [Fact]
    public async Task The_snapshot_says_what_ran_where_and_behind_which_firewall()
    {
        _state.Firewall = new FirewallRulesSnapshot(FirewallBackendKind.Ufw, true, FirewallPolicy.Deny, [new FirewallRuleSpec(FirewallAction.Allow, FirewallProtocol.Tcp, 443)]);
        _docker.Containers.Add(new BackupContainer("shop-api-1", "shop-api:latest", "shop", true, new ContainerSpec([], null, null, null, null, [], [], [], null, null)));
        _docker.Containers.Add(new BackupContainer("blog-web-1", "nginx:1", "blog", false, new ContainerSpec([], null, null, null, null, [], [], [], null, null)));
        _docker.Containers.Add(new BackupContainer("adminer", "adminer:5", null, true, new ContainerSpec(["A=1"], null, null, null, null, [], [], [new PortSpec("8080/tcp", "0.0.0.0", "8081")], "unless-stopped", "bridge")));

        var (archive, _) = await WriteAsync();
        var snapshot = JsonSerializer.Deserialize((await EntriesAsync(archive))["server/server.json"], ServerSnapshotJson.Default.ServerSnapshot)!;

        Assert.Equal(["203.0.113.10", "2001:db8::10"], snapshot.Addresses);
        Assert.Equal(["shop"], snapshot.RunningProjects);
        var standalone = Assert.Single(snapshot.Containers);
        Assert.Equal("adminer", standalone.Name);
        Assert.Equal("8081", standalone.Spec.Ports[0].HostPort);
        Assert.Equal(443, Assert.Single(snapshot.Firewall!.Rules).Port);
        Assert.True(snapshot.LiveCopy);
        Assert.Equal("web-1", snapshot.HostName);
    }

    [Fact]
    public async Task The_core_part_still_stages_with_the_E15_restore()
    {
        _docker.AddVolume("shop_db", new() { ["a"] = [1] });
        var (archive, _) = await WriteAsync();
        var into = Path.Combine(_root, "staged");

        var manifest = await BackupArchive.StageAsync(new MemoryStream(archive), into, KnownMigrations(), 43, Cancel);

        Assert.True(File.Exists(CoreDatabase.PathIn(into)));
        Assert.True(File.Exists(Path.Combine(into, "server", "volumes", "shop_db.tar")));
        Assert.Equal("web-1", manifest.HostName);
        CoreDatabase.ReleasePool(CoreDatabase.PathIn(into));
    }

    [Fact]
    public async Task Without_room_for_it_nothing_is_written()
    {
        _docker.AddVolume("shop_db", new() { ["a"] = new byte[10_000] });

        var error = await Assert.ThrowsAsync<BackupRefusedException>(() => WriteAsync(Composer(freeBytes: 100)));

        Assert.Contains("space", error.Message, StringComparison.Ordinal);
        Assert.Empty(Directory.EnumerateFileSystemEntries(Work));
    }

    [Fact]
    public async Task A_volume_that_cannot_be_read_is_named()
    {
        _docker.AddVolume("broken", new() { ["a"] = [1] });
        _docker.FailVolume = "broken";

        var error = await Assert.ThrowsAsync<BackupRefusedException>(() => WriteAsync());

        Assert.Contains("broken", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Without_docker_the_core_alone_is_backed_up()
    {
        _docker.Available = false;

        var (archive, result) = await WriteAsync();
        var entries = await EntriesAsync(archive);

        Assert.Contains(CoreDatabase.FileName, entries.Keys);
        Assert.DoesNotContain(entries.Keys, name => name.StartsWith("server/volumes/", StringComparison.Ordinal));
        Assert.False(result.Snapshot.Docker);
    }

    private static string[] KnownMigrations()
    {
        using var db = new CoreDbContext(CoreDatabase.Options(":memory:"));
        return [.. Microsoft.EntityFrameworkCore.RelationalDatabaseFacadeExtensions.GetMigrations(db.Database)];
    }
}
