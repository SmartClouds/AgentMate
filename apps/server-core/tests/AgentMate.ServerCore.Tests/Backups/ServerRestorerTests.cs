using System.Formats.Tar;
using System.Text;
using System.Text.Json;
using AgentMate.ServerCore.Audit;
using AgentMate.ServerCore.Backups;
using AgentMate.ServerCore.Contracts;
using AgentMate.ServerCore.Hosting;
using AgentMate.ServerCore.Security;
using Microsoft.Extensions.Time.Testing;

namespace AgentMate.ServerCore.Tests.Backups;

/// <summary>Stacks and websites as a restore brings them up, recorded.</summary>
internal sealed class FakeRestoreTargets : IRestoreTargets
{
    public List<string> Started { get; } = [];

    public int WebsiteApplies { get; private set; }

    public string? FailProject { get; set; }

    public Task<string?> StartProjectAsync(string project, CancellationToken cancellationToken)
    {
        Started.Add(project);
        return Task.FromResult(project == FailProject ? "The stack's deploy job failed: pull access denied." : null);
    }

    public Task<string?> ApplyWebsitesAsync(CancellationToken cancellationToken)
    {
        WebsiteApplies++;
        return Task.FromResult<string?>(null);
    }
}

/// <summary>Moving to a new address, as the restore asks for it.</summary>
internal sealed class FakeAddressRebinder : IAddressRebinder
{
    public List<(string[] Old, string[] New)> Applied { get; } = [];

    public Task<IReadOnlyList<AddressChange>> PlanAsync(string[] oldAddresses, string[] newAddresses, CancellationToken cancellationToken) =>
        Task.FromResult<IReadOnlyList<AddressChange>>([new AddressChange("Cloudflare DNS", "shop.example.com", oldAddresses[0], newAddresses[0], true, null)]);

    public Task<AddressMove> ApplyAsync(string[] oldAddresses, string[] newAddresses, CancellationToken cancellationToken)
    {
        Applied.Add((oldAddresses, newAddresses));
        return Task.FromResult(new AddressMove(
            [new AddressChange("Cloudflare DNS", "shop.example.com", oldAddresses[0], newAddresses[0], true, null)],
            ["blog.example.org"]));
    }
}

/// <summary>
/// Bringing a restored server up (E28): the server/ folder a full backup left in the state folder
/// becomes volumes, images, running stacks, containers and websites again, each step on its own,
/// and the folder goes once it is done.
/// </summary>
public sealed class ServerRestorerTests : IAsyncLifetime
{
    private readonly FakeBackupDocker _docker = new();
    private readonly FakeServerState _state = new() { Addresses = ["198.51.100.7"] };
    private readonly FakeRestoreTargets _targets = new();
    private readonly FakeAddressRebinder _rebinder = new();
    private TestDatabase _database = null!;
    private ServerRestorer _restorer = null!;

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private string Server => Path.Combine(_database.Directory, ServerSnapshot.Folder);

    public async ValueTask InitializeAsync()
    {
        _database = await TestDatabase.CreateAsync();
        var clock = new FakeTimeProvider();
        _restorer = new ServerRestorer(new CoreDirectories(_database.Directory), _docker, _state, _targets, _rebinder, new AuditLog(_database.Contexts, clock, new Redactor()));
    }

    public async ValueTask DisposeAsync() => await _database.DisposeAsync();

    private async Task WriteSnapshotAsync(string[] addresses, params string[] projects)
    {
        Directory.CreateDirectory(Path.Combine(Server, "volumes"));
        Directory.CreateDirectory(Path.Combine(Server, "images"));
        await using (var file = File.Create(Path.Combine(Server, "volumes", "shop_db.tar")))
        await using (var tar = new TarWriter(file, TarEntryFormat.Pax))
        {
            await tar.WriteEntryAsync(new PaxTarEntry(TarEntryType.RegularFile, "base.sql") { DataStream = new MemoryStream("insert"u8.ToArray()) }, Cancel);
        }

        await File.WriteAllTextAsync(Path.Combine(Server, "images", "aaaa.tar"), "shop-api:latest", Cancel);
        var snapshot = new ServerSnapshot(
            ServerSnapshot.CurrentFormat,
            "web-1",
            42,
            addresses,
            true,
            [new VolumeEntry("shop_db", "local", new Dictionary<string, string> { ["com.docker.compose.project"] = "shop" }, "shop_db.tar", 1024)],
            [new ImageEntry("sha256:aaaa", ["shop-api:latest"], [], "aaaa.tar"), new ImageEntry("sha256:bbbb", ["postgres:17"], ["postgres@sha256:1"], null)],
            [new BackupContainer("adminer", "adminer:5", null, true, new ContainerSpec([], null, null, null, null, [], [], [], null, null))],
            projects,
            new FirewallRulesSnapshot(FirewallBackendKind.Ufw, true, FirewallPolicy.Deny, [new FirewallRuleSpec(FirewallAction.Allow, FirewallProtocol.Tcp, 443)]),
            false,
            true);
        await File.WriteAllBytesAsync(Path.Combine(Server, "server.json"), JsonSerializer.SerializeToUtf8Bytes(snapshot, ServerSnapshotJson.Default.ServerSnapshot), Cancel);
    }

    [Fact]
    public async Task Nothing_waits_without_a_server_folder()
    {
        Assert.Null(await _restorer.PendingAsync(Cancel));
        Assert.Null(_restorer.Status);
    }

    [Fact]
    public async Task What_waits_is_described_with_the_move_to_the_new_address()
    {
        await WriteSnapshotAsync(["203.0.113.10"], "shop", "blog");

        var pending = await _restorer.PendingAsync(Cancel);

        Assert.NotNull(pending);
        Assert.Equal(["203.0.113.10"], pending.OldAddresses);
        Assert.Equal(["198.51.100.7"], pending.NewAddresses);
        Assert.Equal((1, 1, 1, 1), (pending.Volumes, pending.SavedImages, pending.PulledImages, pending.Containers));
        Assert.Equal(["shop", "blog"], pending.Projects);
        Assert.Equal(443, Assert.Single(pending.FirewallRules).Port);
        Assert.Equal("shop.example.com", Assert.Single(pending.AddressChanges).Target);
        Assert.True(pending.LiveCopy);
    }

    [Fact]
    public async Task On_the_same_address_there_is_nothing_to_move()
    {
        await WriteSnapshotAsync(["198.51.100.7"], "shop");

        var pending = await _restorer.PendingAsync(Cancel);

        Assert.Empty(pending!.AddressChanges);
    }

    [Fact]
    public async Task Volumes_images_stacks_containers_and_websites_come_back_and_the_folder_goes()
    {
        await WriteSnapshotAsync(["203.0.113.10"], "shop");

        await _restorer.RunAsync(moveAddresses: true, Cancel);

        var status = _restorer.Status!;
        Assert.Equal(BackupRunState.Succeeded, status.State);
        Assert.All(status.Steps, step => Assert.Equal(BackupTargetState.Succeeded, step.State));
        Assert.Equal("insert", Encoding.UTF8.GetString(_docker.Volumes["shop_db"].Files["base.sql"]));
        Assert.Equal("shop", _docker.Volumes["shop_db"].Volume.ComposeProject);
        Assert.Contains("shop-api:latest", _docker.Loaded);
        Assert.Equal(["shop"], _targets.Started);
        Assert.Equal("adminer", Assert.Single(_docker.Recreated).Name);
        Assert.Equal(1, _targets.WebsiteApplies);
        Assert.Single(_rebinder.Applied);
        Assert.Equal(["blog.example.org"], status.ManualDns);
        Assert.Single(status.Applied);
        Assert.False(Directory.Exists(Server));
    }

    [Fact]
    public async Task A_stack_that_will_not_start_fails_on_its_own_and_the_rest_carries_on()
    {
        await WriteSnapshotAsync(["198.51.100.7"], "shop", "blog");
        _targets.FailProject = "shop";

        await _restorer.RunAsync(moveAddresses: true, Cancel);

        var status = _restorer.Status!;
        Assert.Equal(BackupRunState.PartlyFailed, status.State);
        var failed = Assert.Single(status.Steps, step => step.State == BackupTargetState.Failed);
        Assert.Contains("shop", failed.Name, StringComparison.Ordinal);
        Assert.Contains("pull access denied", failed.Detail, StringComparison.Ordinal);
        Assert.Equal(["shop", "blog"], _targets.Started);
        Assert.Empty(_rebinder.Applied);
        Assert.True(Directory.Exists(Server));
    }

    [Fact]
    public async Task Without_docker_it_says_to_install_it_and_keeps_the_folder_for_another_try()
    {
        await WriteSnapshotAsync(["198.51.100.7"], "shop");
        _docker.Available = false;

        await _restorer.RunAsync(moveAddresses: false, Cancel);

        Assert.Equal(BackupRunState.Failed, _restorer.Status!.State);
        Assert.Contains("Install Docker", _restorer.Status.Error, StringComparison.Ordinal);
        Assert.True(Directory.Exists(Server));
    }
}
