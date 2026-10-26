using System.Net;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using Runova.ServerCore.Alerts;
using Runova.ServerCore.Audit;
using Runova.ServerCore.Cli;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Firewall;
using Runova.ServerCore.Hosting;
using Runova.ServerCore.Security;
using static Runova.ServerCore.Tests.FirewallTestData;

namespace Runova.ServerCore.Tests;

/// <summary>
/// Safe apply. The rules are saved and the systemd rollback timer armed before anything changes;
/// a change has to be confirmed over a new SSH connection or the timer puts the old rules back
/// (AC1: the timer is systemd's, so that holds with the core killed; the system tests prove it on
/// real servers). Here the backend is in memory and systemd is the fake process runner, so every
/// command the core would run is pinned.
/// </summary>
public sealed class FirewallManagerTests : IAsyncLifetime
{
    private const string RevertProgram = "/opt/runova-core/releases/9.9.9/runova-core";

    private static readonly IPAddress _server = IPAddress.Parse("192.0.2.10");

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private readonly FakeTimeProvider _clock = new(DateTimeOffset.FromUnixTimeMilliseconds(1_800_000_000_000));
    private readonly string _data = TestFolders.Create("core-firewall");
    private readonly FakeProcessRunner _processes = new();
    private readonly MemoryFirewall _firewall = new();
    private readonly Guid _user = Guid.NewGuid();
    private readonly Guid _device = Guid.NewGuid();
    private TestDatabase _database = null!;
    private AlertCenter _alerts = null!;
    private FirewallManager _manager = null!;

    public async ValueTask InitializeAsync()
    {
        Directory.CreateDirectory(_data);
        _database = await TestDatabase.CreateAsync();
        _alerts = new AlertCenter(_database.Contexts, _clock, new Redactor(), NullLogger<AlertCenter>.Instance);
        var directories = new CoreDirectories(_data);
        var options = new FirewallOptions { RevertProgram = RevertProgram };
        _manager = new FirewallManager(
            new FixedFirewall(_firewall),
            new FixedSshd([22]),
            new SystemdFirewallTimer(Units.Runner(_processes), options, directories),
            _database.Contexts,
            _alerts,
            new AuditLog(_database.Contexts, _clock, new Redactor()),
            directories,
            options,
            _clock,
            NullLogger<FirewallManager>.Instance);

        // What the revert program does when the core runs it: the real command, against the memory firewall.
        _processes.Respond(
            spec => Units.IsUnitRun(spec) && spec.Arguments.Contains("--wait") && Units.Command(spec).Contains(FirewallRevertCommand.Name),
            async call =>
            {
                var exit = await FirewallRevertCommand.RunAsync([.. Units.Command(call.Spec).Skip(1)], TextWriter.Null, TextWriter.Null, _ => _firewall, _clock);
                return FakeProcessRunner.Exit(exit);
            });
    }

    public async ValueTask DisposeAsync()
    {
        _alerts.Dispose();
        await _database.DisposeAsync();
        TestFolders.Delete(_data);
    }

    /// <summary>This computer, over its SSH connection from a given client port.</summary>
    private FirewallCaller Over(int clientPort, bool steppedUp = false, Guid? user = null, Guid? device = null) => new(
        user ?? _user,
        "maria",
        device ?? _device,
        new CallerConnection(new SshEndpoint(App, clientPort, _server, 22), $"connection {clientPort}"),
        steppedUp);

    private static FirewallChangeRequest Request(params FirewallChange[] changes) => new(changes);

    private static bool IsArm(ProcessSpec spec) => Units.IsUnitRun(spec) && spec.Arguments.Any(a => a.StartsWith("--on-active=", StringComparison.Ordinal));

    private static bool IsDisarm(ProcessSpec spec, Guid id) =>
        Path.GetFileName(spec.Program) == "systemctl" && spec.Arguments.SequenceEqual(["stop", $"{SystemdFirewallTimer.UnitFor(id)}.timer"]);

    private FirewallChangeFiles Files(Guid id) => new(_data, id);

    private async Task<Data.FirewallChangeSet> RowAsync(Guid id)
    {
        await using var db = await _database.Contexts.CreateDbContextAsync(Cancel);
        return await db.FirewallChangeSets.AsNoTracking().SingleAsync(row => row.Id == id, Cancel);
    }

    private async Task<FirewallChangeSetInfo> AppliedAsync(int clientPort = 50001) =>
        await _manager.ApplyAsync(Request(Add(Tcp(80))), Over(clientPort), Cancel);

    [Fact]
    public async Task A_change_saves_the_rules_and_arms_the_timer_before_it_touches_anything()
    {
        var before = _firewall.State;
        bool? snapshotOnDisk = null;
        bool? armed = null;
        _firewall.OnApply = () =>
        {
            snapshotOnDisk = Directory.EnumerateFiles(FirewallChangeFiles.Root(_data), "snapshot.json", SearchOption.AllDirectories).Any();
            armed = _processes.Calls.Any(IsArm);
        };

        var change = await AppliedAsync();

        Assert.True(snapshotOnDisk);
        Assert.True(armed);
        Assert.Equal(["snapshot", "apply"], _firewall.Events);
        Assert.Equal(FirewallChangeState.AwaitingConfirmation, change.State);
        Assert.Equal(1_800_000_060_000, change.DeadlineUnixMs);
        Assert.Equal("Allow 80/tcp from anywhere", change.Summary);
        Assert.Equal(["add Allow 80/tcp from anywhere"], change.Commands);
        Assert.Equal(App.ToString(), change.AppliedFrom);
        Assert.NotEqual(before, _firewall.State);
        var arm = Assert.Single(_processes.Calls, IsArm);
        Assert.Contains("--on-active=60s", arm.Arguments);
        Assert.Contains($"--unit={SystemdFirewallTimer.UnitFor(change.Id)}", arm.Arguments);
        Assert.Equal([RevertProgram, "firewall-revert", change.Id.ToString("D"), "--data-directory", _data], Units.Command(arm));
        Assert.Equal(FirewallChangeState.AwaitingConfirmation, (await RowAsync(change.Id)).State);
    }

    [Fact]
    public async Task A_change_that_would_block_ssh_is_refused_without_the_phrase()
    {
        var ssh = _firewall.State.Rules.Single();

        var refusal = await Assert.ThrowsAsync<FirewallRefusedException>(() =>
            _manager.ApplyAsync(Request(Remove(ssh.Id)), Over(50001, steppedUp: true), Cancel));

        Assert.NotNull(refusal.Verdict);
        Assert.True(refusal.Verdict.Blocked);
        Assert.Contains("would cut this computer off", refusal.Message, StringComparison.Ordinal);
        Assert.Contains("\"block ssh on port 22\"", refusal.Message, StringComparison.Ordinal);
        Assert.Empty(_firewall.Events);
        Assert.Empty(_processes.Calls);
        await using var db = await _database.Contexts.CreateDbContextAsync(Cancel);
        Assert.Empty(await db.FirewallChangeSets.ToListAsync(Cancel));
    }

    [Fact]
    public async Task The_wrong_phrase_is_refused_and_the_right_one_needs_a_step_up()
    {
        var ssh = _firewall.State.Rules.Single();

        var wrong = await Assert.ThrowsAsync<FirewallRefusedException>(() =>
            _manager.ApplyAsync(new FirewallChangeRequest([Remove(ssh.Id)], OverrideConfirmation: "yes"), Over(50001, steppedUp: true), Cancel));
        var noStepUp = await Assert.ThrowsAsync<FirewallRefusedException>(() =>
            _manager.ApplyAsync(new FirewallChangeRequest([Remove(ssh.Id)], OverrideConfirmation: "block ssh on port 22"), Over(50001), Cancel));

        Assert.Contains("not the phrase", wrong.Message, StringComparison.Ordinal);
        Assert.True(noStepUp.NeedsStepUp);
        Assert.Empty(_firewall.Events);
    }

    [Fact]
    public async Task With_the_phrase_and_a_step_up_the_change_goes_ahead_and_says_it_was_overridden()
    {
        var ssh = _firewall.State.Rules.Single();

        var change = await _manager.ApplyAsync(
            new FirewallChangeRequest([Remove(ssh.Id)], OverrideConfirmation: "Block SSH on port 22"),
            Over(50001, steppedUp: true),
            Cancel);

        Assert.True(change.GuardOverridden);
        Assert.Empty(_firewall.State.Rules);
        Assert.True((await RowAsync(change.Id)).GuardOverridden);
    }

    [Fact]
    public async Task Turning_the_firewall_on_or_off_needs_a_step_up()
    {
        var refusal = await Assert.ThrowsAsync<FirewallRefusedException>(() =>
            _manager.ApplyAsync(Request(Disable()), Over(50001), Cancel));
        var change = await _manager.ApplyAsync(Request(Disable()), Over(50001, steppedUp: true), Cancel);

        Assert.True(refusal.NeedsStepUp);
        Assert.Contains("password", refusal.Message, StringComparison.Ordinal);
        Assert.False(_firewall.State.Active);
        Assert.Equal(FirewallChangeState.AwaitingConfirmation, change.State);
    }

    [Fact]
    public async Task A_failing_step_puts_the_old_rules_back_at_once_and_disarms_the_timer()
    {
        var before = _firewall.State;
        _firewall.ApplyFailure = new FirewallStepFailedException("\"ufw allow in proto tcp from any to any port 80\" failed (exit code 1): ERROR: Bad port");

        var refusal = await Assert.ThrowsAsync<FirewallRefusedException>(() => AppliedAsync());

        Assert.Contains("ERROR: Bad port", refusal.Message, StringComparison.Ordinal);
        Assert.Contains("put back as it was", refusal.Message, StringComparison.Ordinal);
        Assert.Same(before, _firewall.State);
        Assert.Equal(["snapshot", "apply", "restore"], _firewall.Events);
        var row = await (await _database.Contexts.CreateDbContextAsync(Cancel)).FirewallChangeSets.SingleAsync(Cancel);
        Assert.Equal(FirewallChangeState.RolledBack, row.State);
        Assert.Equal(FirewallRollbackCause.ApplyFailed, row.RolledBackBy);
        Assert.Contains(_processes.Calls, spec => IsDisarm(spec, row.Id));
        Assert.Equal(FirewallDecision.Reverted, Files(row.Id).Decision());
    }

    [Fact]
    public async Task When_the_firewall_does_not_show_the_change_it_is_rolled_back()
    {
        _firewall.IgnoreChanges = true;

        var refusal = await Assert.ThrowsAsync<FirewallRefusedException>(() => AppliedAsync());

        Assert.Contains("\"Allow 80/tcp from anywhere\" is not in the firewall's rules", refusal.Message, StringComparison.Ordinal);
        Assert.Equal(["snapshot", "apply", "restore"], _firewall.Events);
    }

    [Fact]
    public async Task When_the_timer_cannot_be_armed_nothing_is_changed()
    {
        _processes.Respond(IsArm, _ => FakeProcessRunner.Exit(1, error: "Failed to start transient timer unit: Access denied"));

        var refusal = await Assert.ThrowsAsync<FirewallRefusedException>(() => AppliedAsync());

        Assert.Contains("rollback timer could not be armed, so nothing was changed", refusal.Message, StringComparison.Ordinal);
        Assert.Contains("Access denied", refusal.Message, StringComparison.Ordinal);
        Assert.Equal(["snapshot"], _firewall.Events);
        var row = await (await _database.Contexts.CreateDbContextAsync(Cancel)).FirewallChangeSets.SingleAsync(Cancel);
        Assert.Equal(FirewallChangeState.Failed, row.State);
    }

    [Fact]
    public async Task A_confirmation_over_the_same_connection_is_refused_and_over_a_new_one_keeps_the_change()
    {
        var change = await AppliedAsync(clientPort: 50001);

        var same = await Assert.ThrowsAsync<FirewallRefusedException>(() => _manager.ConfirmAsync(change.Id, Over(50001), Cancel));
        var confirmed = await _manager.ConfirmAsync(change.Id, Over(50002), Cancel);

        Assert.Contains("same SSH connection", same.Message, StringComparison.Ordinal);
        Assert.Equal(FirewallChangeState.Confirmed, confirmed.State);
        Assert.Contains(_processes.Calls, spec => IsDisarm(spec, change.Id));
        Assert.Equal(FirewallDecision.Confirmed, Files(change.Id).Decision());
        Assert.Equal(["snapshot", "apply"], _firewall.Events);
    }

    [Fact]
    public async Task A_confirmation_the_core_cannot_place_is_refused_when_the_change_came_over_ssh()
    {
        var change = await AppliedAsync();
        var unplaced = Over(50002) with { Connection = new CallerConnection(null, "connection 9") };

        var refusal = await Assert.ThrowsAsync<FirewallRefusedException>(() => _manager.ConfirmAsync(change.Id, unplaced, Cancel));

        Assert.Contains("could not tell which SSH connection", refusal.Message, StringComparison.Ordinal);
        Assert.Null(Files(change.Id).Decision());
    }

    [Fact]
    public async Task Only_the_person_and_computer_that_made_the_change_can_confirm_it()
    {
        var change = await AppliedAsync();

        var someoneElse = await Assert.ThrowsAsync<FirewallRefusedException>(() =>
            _manager.ConfirmAsync(change.Id, Over(50002, user: Guid.NewGuid()), Cancel));
        var otherComputer = await Assert.ThrowsAsync<FirewallRefusedException>(() =>
            _manager.ConfirmAsync(change.Id, Over(50002, device: Guid.NewGuid()), Cancel));

        Assert.Contains("person who made", someoneElse.Message, StringComparison.Ordinal);
        Assert.Contains("computer that made", otherComputer.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_confirmation_after_the_timer_fired_is_too_late()
    {
        var change = await AppliedAsync();
        var before = _firewall.State;
        _clock.Advance(TimeSpan.FromSeconds(61));
        // The timer's own run of the revert program.
        await FirewallRevert.RunAsync(Files(change.Id), _ => _firewall, _clock, _ => { }, Cancel);

        var refusal = await Assert.ThrowsAsync<FirewallRefusedException>(() => _manager.ConfirmAsync(change.Id, Over(50002), Cancel));

        Assert.Contains("Too late", refusal.Message, StringComparison.Ordinal);
        Assert.NotSame(before, _firewall.State);
        var row = await RowAsync(change.Id);
        Assert.Equal(FirewallChangeState.RolledBack, row.State);
        Assert.Equal(FirewallRollbackCause.Timer, row.RolledBackBy);
        Assert.Single(await _alerts.OpenAsync(AlertKind.FirewallRolledBack, Cancel));
    }

    [Fact]
    public async Task A_change_from_a_connection_the_core_cannot_place_needs_the_phrase_and_a_step_up()
    {
        var unplaced = Over(50001, steppedUp: true) with { Connection = new CallerConnection(null, "connection 3") };
        var request = new FirewallChangeRequest([Add(Tcp(80))], SshConnection: "203.0.113.50 50001 192.0.2.10 22");

        var refusal = await Assert.ThrowsAsync<FirewallRefusedException>(() => _manager.ApplyAsync(request, unplaced, Cancel));
        var change = await _manager.ApplyAsync(request with { OverrideConfirmation = LockoutGuard.UnknownPhrase }, unplaced, Cancel);

        Assert.Contains("could not tell which SSH connection", refusal.Message, StringComparison.Ordinal);
        Assert.True(change.GuardOverridden);
    }

    [Fact]
    public async Task A_timer_that_fires_while_the_change_is_still_running_is_honored()
    {
        var before = _firewall.State;
        _firewall.OnApply = () =>
        {
            var folder = Directory.EnumerateDirectories(FirewallChangeFiles.Root(_data)).Single();
            var files = new FirewallChangeFiles(_data, Guid.ParseExact(Path.GetFileName(folder), "N"));
            FirewallRevert.RunAsync(files, _ => _firewall, _clock, _ => { }, Cancel).GetAwaiter().GetResult();
        };

        var refusal = await Assert.ThrowsAsync<FirewallRefusedException>(() => AppliedAsync());

        Assert.Contains("took longer than", refusal.Message, StringComparison.Ordinal);
        Assert.Same(before, _firewall.State);
        var row = await (await _database.Contexts.CreateDbContextAsync(Cancel)).FirewallChangeSets.SingleAsync(Cancel);
        Assert.Equal(FirewallChangeState.RolledBack, row.State);
        Assert.Equal(FirewallRollbackCause.Timer, row.RolledBackBy);
    }

    [Fact]
    public async Task One_change_waits_for_confirmation_at_a_time()
    {
        await AppliedAsync();

        var refusal = await Assert.ThrowsAsync<FirewallRefusedException>(() =>
            _manager.ApplyAsync(Request(Add(Tcp(443))), Over(50001), Cancel));

        Assert.Contains("waiting for its confirmation", refusal.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Reverting_by_hand_puts_the_rules_back_and_disarms_the_timer()
    {
        var before = _firewall.State;
        var change = await AppliedAsync();

        var reverted = await _manager.RevertAsync(change.Id, Over(50001), Cancel);

        Assert.Equal(FirewallChangeState.RolledBack, reverted.State);
        Assert.Equal(FirewallRollbackCause.User, reverted.RolledBackBy);
        Assert.Same(before, _firewall.State);
        Assert.Contains(_processes.Calls, spec => IsDisarm(spec, change.Id));
        Assert.Empty(await _alerts.OpenAsync(AlertKind.FirewallRolledBack, Cancel));
    }

    [Fact]
    public async Task After_the_timer_fired_the_core_records_the_rollback_and_raises_an_alert()
    {
        var change = await AppliedAsync();
        _clock.Advance(TimeSpan.FromSeconds(61));
        await FirewallRevert.RunAsync(Files(change.Id), _ => _firewall, _clock, _ => { }, Cancel);

        await _manager.ReconcileAsync(Cancel);

        var row = await RowAsync(change.Id);
        Assert.Equal(FirewallChangeState.RolledBack, row.State);
        Assert.Equal(FirewallRollbackCause.Timer, row.RolledBackBy);
        var alert = Assert.Single(await _alerts.OpenAsync(AlertKind.FirewallRolledBack, Cancel));
        Assert.Equal(AlertSeverity.Warning, alert.Severity);
        Assert.Contains("Allow 80/tcp from anywhere", alert.Message, StringComparison.Ordinal);
        await using var db = await _database.Contexts.CreateDbContextAsync(Cancel);
        Assert.Contains(await db.AuditEvents.Select(e => e.Action + ":" + e.Result).ToListAsync(Cancel), entry => entry == "firewall.rolled-back:success");
    }

    [Fact]
    public async Task A_change_whose_timer_vanished_is_rolled_back_by_the_core()
    {
        var before = _firewall.State;
        var change = await AppliedAsync();
        // A reboot ends every transient unit; systemd then knows no such timer.
        _processes.Respond("systemctl", ["show"], _ => FakeProcessRunner.Ok("dead\n"));

        await _manager.ReconcileAsync(Cancel);

        Assert.Same(before, _firewall.State);
        var row = await RowAsync(change.Id);
        Assert.Equal(FirewallChangeState.RolledBack, row.State);
        Assert.Equal(FirewallRollbackCause.Restart, row.RolledBackBy);
        Assert.Single(await _alerts.OpenAsync(AlertKind.FirewallRolledBack, Cancel));
    }

    [Fact]
    public async Task A_waiting_timer_is_left_to_do_its_work_until_the_deadline_has_long_passed()
    {
        var before = _firewall.State;
        var change = await AppliedAsync();
        _processes.Respond("systemctl", ["show"], _ => FakeProcessRunner.Ok("waiting\n"));

        _clock.Advance(TimeSpan.FromSeconds(65));
        await _manager.ReconcileAsync(Cancel);
        var stillWaiting = (await RowAsync(change.Id)).State;
        _clock.Advance(TimeSpan.FromSeconds(30));
        await _manager.ReconcileAsync(Cancel);

        Assert.Equal(FirewallChangeState.AwaitingConfirmation, stillWaiting);
        Assert.Same(before, _firewall.State);
        Assert.Equal(FirewallRollbackCause.Timer, (await RowAsync(change.Id)).RolledBackBy);
    }

    [Fact]
    public async Task A_failed_rollback_raises_a_critical_alert_and_leaves_the_timer_armed()
    {
        _firewall.ApplyFailure = new FirewallStepFailedException("\"ufw allow\" failed");
        _firewall.RestoreFailure = new FirewallStepFailedException("\"ufw reload\" failed (exit code 1): ERROR: problem running ufw-init");

        var refusal = await Assert.ThrowsAsync<FirewallRefusedException>(() => AppliedAsync());

        Assert.Contains("problem running ufw-init", refusal.Message, StringComparison.Ordinal);
        var row = await (await _database.Contexts.CreateDbContextAsync(Cancel)).FirewallChangeSets.SingleAsync(Cancel);
        Assert.Equal(FirewallChangeState.RollbackFailed, row.State);
        Assert.DoesNotContain(_processes.Calls, spec => IsDisarm(spec, row.Id));
        Assert.Equal(AlertSeverity.Critical, Assert.Single(await _alerts.OpenAsync(AlertKind.FirewallRollbackFailed, Cancel)).Severity);
    }

    [Fact]
    public async Task A_change_set_that_changes_nothing_is_refused()
    {
        var refusal = await Assert.ThrowsAsync<FirewallRefusedException>(() =>
            _manager.ApplyAsync(Request(Add(Tcp(22))), Over(50001), Cancel));

        Assert.Contains("Nothing would change", refusal.Message, StringComparison.Ordinal);
        Assert.Empty(_firewall.Events);
    }

    [Fact]
    public async Task The_status_shows_the_change_waiting_for_confirmation()
    {
        var change = await AppliedAsync();

        var status = await _manager.StatusAsync(Cancel);

        Assert.Equal(change.Id, status.Pending?.Id);
        Assert.Equal(1_800_000_060_000, status.Pending?.DeadlineUnixMs);
        Assert.Equal(60, status.ConfirmWithinSeconds);
        Assert.Equal([22], status.Ssh.Ports);
        Assert.Contains(status.Rules, rule => rule.Description == "Allow 80/tcp from anywhere");
    }

    [Fact]
    public async Task A_confirmed_change_resolves_earlier_rollback_alerts()
    {
        var first = await AppliedAsync();
        _clock.Advance(TimeSpan.FromSeconds(61));
        await FirewallRevert.RunAsync(Files(first.Id), _ => _firewall, _clock, _ => { }, Cancel);
        await _manager.ReconcileAsync(Cancel);

        var second = await AppliedAsync(clientPort: 50003);
        await _manager.ConfirmAsync(second.Id, Over(50004), Cancel);

        Assert.Empty(await _alerts.OpenAsync(AlertKind.FirewallRolledBack, Cancel));
    }

    [Fact]
    public async Task A_preview_shows_the_commands_and_the_guards_verdict_without_changing_anything()
    {
        var ssh = _firewall.State.Rules.Single();

        var preview = await _manager.PreviewAsync(Request(Remove(ssh.Id), Add(Tcp(443))), Over(50001), Cancel);

        Assert.True(preview.Guard.Blocked);
        Assert.Equal("block ssh on port 22", preview.Guard.ConfirmationPhrase);
        Assert.True(preview.NeedsStepUp);
        Assert.Equal(["add Allow 443/tcp from anywhere", "remove Allow 22/tcp from anywhere"], preview.Commands);
        Assert.Equal(["Allow 443/tcp from anywhere"], preview.ResultingRules.Select(rule => rule.Description));
        Assert.Equal(60, preview.ConfirmWithinSeconds);
        Assert.Empty(_firewall.Events);
        Assert.Empty(_processes.Calls);
    }

    [Fact]
    public async Task The_desktops_view_of_the_connection_is_checked_too()
    {
        var change = await _manager.ApplyAsync(
            new FirewallChangeRequest([Add(Tcp(80))], SshConnection: "198.51.100.77 41000 192.0.2.10 22"),
            Over(50001),
            Cancel);
        var bad = await Assert.ThrowsAsync<FirewallRefusedException>(() =>
            _manager.PreviewAsync(new FirewallChangeRequest([Add(Tcp(81))], SshConnection: "nonsense"), Over(50001), Cancel));
        var preview = await _manager.PreviewAsync(
            new FirewallChangeRequest([Add(new FirewallRuleSpec(FirewallAction.Deny, FirewallProtocol.Any, Source: "198.51.100.0/24"))], SshConnection: "198.51.100.77 41000 192.0.2.10 22"),
            Over(50001),
            Cancel);

        Assert.Equal(FirewallChangeState.AwaitingConfirmation, change.State);
        Assert.Contains("$SSH_CONNECTION", bad.Message, StringComparison.Ordinal);
        Assert.True(preview.Guard.Blocked);
        Assert.Contains("198.51.100.77", Assert.Single(preview.Guard.Reasons), StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_history_lists_changes_newest_first()
    {
        var first = await AppliedAsync();
        await _manager.RevertAsync(first.Id, Over(50001), Cancel);
        _clock.Advance(TimeSpan.FromSeconds(1));
        var second = await AppliedAsync();

        var history = await _manager.ListAsync(new FirewallChangeSetQuery(Limit: 10), Cancel);

        Assert.Equal([second.Id, first.Id], history.Select(change => change.Id));
        Assert.Equal("maria", history[0].RequestedBy);
    }

    /// <summary>An in-memory firewall that records what was done to it.</summary>
    private sealed class MemoryFirewall : IFirewallBackend
    {
        private readonly Dictionary<string, FirewallState> _saved = new(StringComparer.Ordinal);

        public FirewallState State { get; set; } = Ufw(rules: [Allow(22)]);

        public List<string> Events { get; } = [];

        public Action? OnApply { get; set; }

        public Exception? ApplyFailure { get; set; }

        public Exception? RestoreFailure { get; set; }

        public bool IgnoreChanges { get; set; }

        public FirewallBackendKind Kind => State.Backend;

        public Task<FirewallState> ReadAsync(CancellationToken cancellationToken) => Task.FromResult(State);

        public IReadOnlyList<FirewallStep> Steps(FirewallChangePlan plan) =>
        [
            .. plan.Added.Select(rule => new FirewallStep($"add {FirewallEvaluation.Describe(rule)}")),
            .. plan.Removed.Select(rule => new FirewallStep($"remove {FirewallEvaluation.Describe(rule)}")),
            .. plan.DefaultIncoming is { } policy ? [new FirewallStep($"default {policy}")] : Array.Empty<FirewallStep>(),
            .. plan.Enable is { } on ? [new FirewallStep(on ? "enable" : "disable")] : Array.Empty<FirewallStep>(),
        ];

        public Task ApplyAsync(FirewallChangePlan plan, IReadOnlyList<FirewallStep> steps, Action<string> log, CancellationToken cancellationToken)
        {
            Events.Add("apply");
            OnApply?.Invoke();
            if (!IgnoreChanges)
            {
                State = plan.Result;
            }

            return ApplyFailure is { } failure ? Task.FromException(failure) : Task.CompletedTask;
        }

        public Task<FirewallSnapshot> SnapshotAsync(CancellationToken cancellationToken)
        {
            Events.Add("snapshot");
            var token = Guid.NewGuid().ToString("N");
            _saved[token] = State;
            return Task.FromResult(new FirewallSnapshot(Kind, [new SnapshotFile("/memory", token, UnixFileMode.UserRead)], 0));
        }

        public Task RestoreAsync(FirewallSnapshot snapshot, Action<string> log, CancellationToken cancellationToken)
        {
            Events.Add("restore");
            if (RestoreFailure is { } failure)
            {
                return Task.FromException(failure);
            }

            State = _saved[snapshot.Files[0].Content!];
            return Task.CompletedTask;
        }
    }

    private sealed class FixedFirewall(IFirewallBackend backend) : IFirewallBackendSource
    {
        public IFirewallBackend Current() => backend;
    }

    private sealed class FixedSshd(int[] ports) : ISshdSettings
    {
        public Task<SshPortsInfo> ReadAsync(CancellationToken cancellationToken) => Task.FromResult(new SshPortsInfo(ports));
    }
}
