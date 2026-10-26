using Microsoft.Extensions.Time.Testing;
using Runova.ServerCore.Cli;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Firewall;

namespace Runova.ServerCore.Tests;

/// <summary>
/// What the rollback timer runs (runova-core firewall-revert): it puts the saved rules back
/// unless the change was confirmed first, with nothing but the change set's folder, so it works
/// with the core killed (AC1). Confirming and reverting race through one file that only the
/// first of them can create.
/// </summary>
public sealed class FirewallRevertTests : IDisposable
{
    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private readonly string _data = TestFolders.Create("core-firewall");
    private readonly Guid _id = Guid.Parse("6f1c2b0e-8d4a-4f3b-9c2e-1a5d7e9b3c40");
    private readonly FakeTimeProvider _clock = new(DateTimeOffset.FromUnixTimeMilliseconds(1_800_000_000_000));
    private readonly SnapshotBackend _backend = new();

    public FirewallRevertTests() => Directory.CreateDirectory(_data);

    public void Dispose() => TestFolders.Delete(_data);

    private FirewallChangeFiles Files() => new(_data, _id);

    private static FirewallSnapshot Snapshot() => new(
        FirewallBackendKind.Ufw,
        [new SnapshotFile("/etc/ufw/user.rules", "*filter\nCOMMIT\n", UnixFileMode.UserRead | UnixFileMode.UserWrite)],
        TakenAtUnixMs: 1_799_999_990_000);

    private Task<FirewallRevertOutcome> RevertAsync() =>
        FirewallRevert.RunAsync(Files(), kind => kind == FirewallBackendKind.Ufw ? _backend : null, _clock, _ => { }, Cancel);

    [Fact]
    public async Task The_saved_rules_go_back_and_the_outcome_is_written_down()
    {
        Files().WriteSnapshot(Snapshot());

        var outcome = await RevertAsync();

        Assert.Equal(FirewallRevertOutcome.Restored, outcome);
        var restored = Assert.Single(_backend.Restored);
        Assert.Equal("*filter\nCOMMIT\n", restored.Files[0].Content);
        Assert.Equal(FirewallDecision.Reverted, Files().Decision());
        var result = Files().ReadResult();
        Assert.NotNull(result);
        Assert.True(result.Restored);
        Assert.Equal(1_800_000_000_000, result.AtUnixMs);
        Assert.Contains("restored", result.Log, StringComparer.Ordinal);
    }

    [Fact]
    public async Task A_confirmed_change_is_left_alone()
    {
        Files().WriteSnapshot(Snapshot());
        Assert.Equal(FirewallDecision.Confirmed, Files().Decide(FirewallDecision.Confirmed));

        var outcome = await RevertAsync();

        Assert.Equal(FirewallRevertOutcome.AlreadyConfirmed, outcome);
        Assert.Empty(_backend.Restored);
        Assert.Null(Files().ReadResult());
    }

    [Fact]
    public async Task Whoever_decides_first_wins_and_the_other_learns_it()
    {
        Files().WriteSnapshot(Snapshot());
        await RevertAsync();

        // A confirmation arriving after the timer fired finds the change already put back.
        Assert.Equal(FirewallDecision.Reverted, Files().Decide(FirewallDecision.Confirmed));
        Assert.Equal(FirewallDecision.Reverted, Files().Decision());
    }

    [Fact]
    public async Task Running_again_after_a_revert_changes_nothing()
    {
        Files().WriteSnapshot(Snapshot());
        await RevertAsync();

        var again = await RevertAsync();

        Assert.Equal(FirewallRevertOutcome.AlreadyReverted, again);
        Assert.Single(_backend.Restored);
    }

    [Fact]
    public async Task A_failed_restore_is_written_down_and_tried_again_on_the_next_run()
    {
        Files().WriteSnapshot(Snapshot());
        _backend.Failure = new FirewallStepFailedException("\"ufw reload\" failed (exit code 1): ERROR: problem running ufw-init");

        var failed = await RevertAsync();
        _backend.Failure = null;
        var retried = await RevertAsync();

        Assert.Equal(FirewallRevertOutcome.Failed, failed);
        Assert.Equal(FirewallRevertOutcome.Restored, retried);
        Assert.Equal(2, _backend.Restored.Count);
        Assert.True(Files().ReadResult()!.Restored);
    }

    [Fact]
    public async Task A_failure_says_why_in_the_result()
    {
        Files().WriteSnapshot(Snapshot());
        _backend.Failure = new FirewallStepFailedException("\"ufw reload\" failed (exit code 1): ERROR: problem running ufw-init");

        await RevertAsync();

        var result = Files().ReadResult()!;
        Assert.False(result.Restored);
        Assert.Contains("problem running ufw-init", result.Error, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Without_a_snapshot_there_is_nothing_to_put_back_and_that_is_a_failure()
    {
        Directory.CreateDirectory(Files().Folder);

        var outcome = await RevertAsync();

        Assert.Equal(FirewallRevertOutcome.Failed, outcome);
        Assert.Contains("saved rules", Files().ReadResult()!.Error, StringComparison.Ordinal);
    }

    [Fact]
    public void The_snapshot_round_trips_through_its_file()
    {
        var snapshot = Snapshot() with { ServiceActive = true, ServiceEnabled = false, Zone = "public" };

        Files().WriteSnapshot(snapshot);
        var read = Files().ReadSnapshot()!;

        Assert.Equal(snapshot.Backend, read.Backend);
        Assert.Equal(snapshot.Files[0], read.Files[0]);
        Assert.True(read.ServiceActive);
        Assert.False(read.ServiceEnabled);
        Assert.Equal("public", read.Zone);
        Assert.Contains("\"Backend\": \"Ufw\"", File.ReadAllText(Files().SnapshotPath), StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_command_restores_from_the_folder_it_is_pointed_at()
    {
        Files().WriteSnapshot(Snapshot());
        using var output = new StringWriter();
        using var error = new StringWriter();

        var exit = await FirewallRevertCommand.RunAsync(
            [FirewallRevertCommand.Name, _id.ToString("D"), "--data-directory", _data],
            output,
            error,
            kind => kind == FirewallBackendKind.Ufw ? _backend : null,
            _clock);

        Assert.Equal(0, exit);
        Assert.Single(_backend.Restored);
        Assert.Contains("put back", output.ToString(), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("firewall-revert")]
    [InlineData("firewall-revert not-a-guid --data-directory /var/lib/runova-core")]
    [InlineData("firewall-revert 6f1c2b0e-8d4a-4f3b-9c2e-1a5d7e9b3c40 --data-directory relative/path")]
    [InlineData("firewall-revert 6f1c2b0e-8d4a-4f3b-9c2e-1a5d7e9b3c40 --data-directory")]
    [InlineData("firewall-revert 6f1c2b0e-8d4a-4f3b-9c2e-1a5d7e9b3c40 --force")]
    public async Task The_command_takes_exactly_an_id_and_an_absolute_folder(string commandLine)
    {
        using var output = new StringWriter();
        using var error = new StringWriter();

        var exit = await FirewallRevertCommand.RunAsync(commandLine.Split(' '), output, error, _ => _backend, _clock);

        Assert.Equal(2, exit);
        Assert.Contains("Usage: runova-core firewall-revert", error.ToString(), StringComparison.Ordinal);
        Assert.Empty(_backend.Restored);
    }

    [Fact]
    public async Task The_command_fails_when_the_restore_does()
    {
        Files().WriteSnapshot(Snapshot());
        _backend.Failure = new FirewallStepFailedException("\"ufw reload\" failed");
        using var output = new StringWriter();
        using var error = new StringWriter();

        var exit = await FirewallRevertCommand.RunAsync(
            [FirewallRevertCommand.Name, _id.ToString("N"), "--data-directory", _data],
            output,
            error,
            _ => _backend,
            _clock);

        Assert.Equal(1, exit);
        Assert.Contains("\"ufw reload\" failed", error.ToString(), StringComparison.Ordinal);
    }

    /// <summary>A backend that only restores: what the revert program needs of it.</summary>
    private sealed class SnapshotBackend : IFirewallBackend
    {
        public List<FirewallSnapshot> Restored { get; } = [];

        public Exception? Failure { get; set; }

        public FirewallBackendKind Kind => FirewallBackendKind.Ufw;

        public Task<FirewallState> ReadAsync(CancellationToken cancellationToken) => throw new NotSupportedException();

        public IReadOnlyList<FirewallStep> Steps(FirewallChangePlan plan) => throw new NotSupportedException();

        public Task ApplyAsync(FirewallChangePlan plan, IReadOnlyList<FirewallStep> steps, Action<string> log, CancellationToken cancellationToken) =>
            throw new NotSupportedException();

        public Task<FirewallSnapshot> SnapshotAsync(CancellationToken cancellationToken) => throw new NotSupportedException();

        public Task RestoreAsync(FirewallSnapshot snapshot, Action<string> log, CancellationToken cancellationToken)
        {
            Restored.Add(snapshot);
            if (Failure is { } failure)
            {
                throw failure;
            }

            log("restored");
            return Task.CompletedTask;
        }
    }
}
