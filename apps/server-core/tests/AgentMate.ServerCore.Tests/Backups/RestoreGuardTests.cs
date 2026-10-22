using AgentMate.ServerCore.Cli;
using AgentMate.ServerCore.Contracts;
using AgentMate.ServerCore.Data;
using AgentMate.ServerCore.Firewall;
using AgentMate.ServerCore.Hardening;
using Microsoft.Extensions.DependencyInjection;

namespace AgentMate.ServerCore.Tests.Backups;

/// <summary>
/// A restore swaps the whole state folder, so a firewall or SSH change still waiting to be kept
/// would lose the files its rollback timer needs, and could stay in place for good. Restore-stage
/// refuses while one waits, naming it, and goes ahead once it is decided. The guard runs before
/// the backup is even opened, so these tests hand it a file that is not a backup: getting past
/// the guard shows as the backup being refused instead.
/// </summary>
public sealed class RestoreGuardTests : IDisposable
{
    private const string NotABackup = "not an AgentMate server backup";

    private readonly string _server = Path.Combine(Path.GetTempPath(), $"core-guard-{Guid.NewGuid():N}");

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private AdminEnvironment Environment => new(_server, TimeProvider.System, 1000, "deployer");

    public void Dispose() => TestFolders.Delete(_server);

    private async Task<(int Code, string Error, string Into)> RestoreAsync()
    {
        Directory.CreateDirectory(_server);
        var file = Path.Combine(_server, "upload.ambackup");
        await File.WriteAllTextAsync(file, "hello", Cancel);
        var into = Path.Combine(_server, "stage");
        using var input = new StringReader("orange tractor bicycle lamp\n");
        using var error = new StringWriter();
        var code = await AdminCli.RunAsync(
            ["restore-stage", "--file", file, "--into", into, "--passphrase-stdin"],
            input,
            new StringWriter(),
            error,
            () => Environment);
        return (code, error.ToString(), into);
    }

    private SshChangeFiles PendingSshChange()
    {
        var files = new SshChangeFiles(_server, Guid.NewGuid());
        files.WriteSnapshot(new SshChangeSnapshot(files.Id, "SSH password login off", null, "ssh", "maria", "ssh a", 1, 60_001));
        return files;
    }

    private async Task<Guid> FirewallChangeAsync(FirewallChangeState state)
    {
        await CoreDatabase.PrepareAsync(CoreDatabase.PathIn(_server), Cancel);
        var id = Guid.NewGuid();
        new FirewallChangeFiles(_server, id).WriteSnapshot(new FirewallSnapshot(FirewallBackendKind.Ufw, [], 1));
        await using var services = AdminCli.BuildServices(Environment);
        await using var scope = services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<CoreDbContext>();
        db.FirewallChangeSets.Add(new FirewallChangeSet
        {
            Id = id,
            Backend = FirewallBackendKind.Ufw,
            State = state,
            Summary = "Allow 8080/tcp from anywhere",
            Changes = "[]",
            Commands = "[]",
            CreatedAt = 1,
            AppliedOver = "ssh a",
        });
        await db.SaveChangesAsync(Cancel);
        CoreDatabase.ReleasePool(CoreDatabase.PathIn(_server));
        return id;
    }

    [Fact]
    public async Task An_ssh_change_waiting_to_be_kept_blocks_the_restore()
    {
        var pending = PendingSshChange();

        var (code, error, into) = await RestoreAsync();

        Assert.Equal(1, code);
        Assert.Contains("SSH change \"SSH password login off\"", error, StringComparison.Ordinal);
        Assert.Contains(pending.Id.ToString("D"), error, StringComparison.Ordinal);
        Assert.Contains("Keep or revert", error, StringComparison.Ordinal);
        Assert.DoesNotContain(NotABackup, error, StringComparison.Ordinal);
        Assert.False(Directory.Exists(into));
    }

    [Fact]
    public async Task A_decided_ssh_change_does_not()
    {
        PendingSshChange().Decide(SshDecision.Confirmed);

        var (code, error, _) = await RestoreAsync();

        Assert.Equal(1, code);
        Assert.Contains(NotABackup, error, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_firewall_change_waiting_to_be_kept_blocks_the_restore()
    {
        var id = await FirewallChangeAsync(FirewallChangeState.AwaitingConfirmation);

        var (code, error, into) = await RestoreAsync();

        Assert.Equal(1, code);
        Assert.Contains("firewall change \"Allow 8080/tcp from anywhere\"", error, StringComparison.Ordinal);
        Assert.Contains(id.ToString("D"), error, StringComparison.Ordinal);
        Assert.False(Directory.Exists(into));
    }

    [Theory]
    [InlineData(FirewallChangeState.Failed)]
    [InlineData(FirewallChangeState.RolledBack)]
    public async Task A_decided_or_failed_firewall_change_does_not(FirewallChangeState state)
    {
        // A change whose timer never armed has no decision file, but nothing to roll back either.
        await FirewallChangeAsync(state);

        var (code, error, _) = await RestoreAsync();

        Assert.Equal(1, code);
        Assert.Contains(NotABackup, error, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_backup_being_made_blocks_the_restore_and_a_finished_one_does_not()
    {
        await CoreDatabase.PrepareAsync(CoreDatabase.PathIn(_server), Cancel);
        var id = Guid.NewGuid();
        await using (var services = AdminCli.BuildServices(Environment))
        await using (var scope = services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<CoreDbContext>();
            db.BackupRuns.Add(new BackupRunRecord { Id = id, PlanName = "Nightly", State = BackupRunState.Running, StartedAt = 1 });
            await db.SaveChangesAsync(Cancel);
        }

        CoreDatabase.ReleasePool(CoreDatabase.PathIn(_server));
        var (_, waiting, _) = await RestoreAsync();
        await using (var services = AdminCli.BuildServices(Environment))
        await using (var scope = services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<CoreDbContext>();
            (await db.BackupRuns.FindAsync([id], Cancel))!.State = BackupRunState.Succeeded;
            await db.SaveChangesAsync(Cancel);
        }

        CoreDatabase.ReleasePool(CoreDatabase.PathIn(_server));
        var (_, finished, _) = await RestoreAsync();

        Assert.Contains("backup \"Nightly\" being made", waiting, StringComparison.Ordinal);
        Assert.Contains(NotABackup, finished, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_confirmed_firewall_change_does_not()
    {
        var id = await FirewallChangeAsync(FirewallChangeState.AwaitingConfirmation);
        new FirewallChangeFiles(_server, id).Decide(FirewallDecision.Confirmed);

        var (_, error, _) = await RestoreAsync();

        Assert.Contains(NotABackup, error, StringComparison.Ordinal);
    }
}
