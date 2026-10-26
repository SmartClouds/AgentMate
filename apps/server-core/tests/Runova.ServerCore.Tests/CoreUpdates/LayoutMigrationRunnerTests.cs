using Runova.ServerCore.Contracts;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Hosting;
using Runova.ServerCore.Updates;

namespace Runova.ServerCore.Tests.CoreUpdates;

/// <summary>
/// How a migration run goes, with the shell faked: the journal around every step, a rollback that
/// undoes what ran (last first) when a step fails or the new core does not hold, a resume that
/// carries on where the journal stopped, and the checks that keep it from starting at all.
/// </summary>
public sealed class LayoutMigrationRunnerTests : IDisposable
{
    private static readonly string _release = CoreLayout.Legacy.Releases + "/1.64.0-0123456789ab";

    private readonly string _folder = TestFolders.Create("layout-migration");
    private readonly FakeProcessRunner _runner = new();
    private readonly LayoutMigrationJournalFile _journal;
    private readonly StringWriter _output = new();
    private readonly List<string> _pending = [];
    private bool _answers = true;

    public LayoutMigrationRunnerTests()
    {
        Directory.CreateDirectory(_folder);
        _journal = new LayoutMigrationJournalFile(Path.Combine(_folder, "migration.json"));
    }

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private LayoutMigrationRunner Runner() => new(
        _runner,
        _journal,
        TimeProvider.System,
        _ => Task.FromResult(_answers),
        _ => Task.FromResult<IReadOnlyList<string>>(_pending),
        _output)
    {
        Watch = TimeSpan.Zero,
        OwnUnit = "runova-migrate-0123456789abcdef0123456789abcdef",
    };

    /// <summary>The step scripts that ran, by name, in order: what each Do or Undo script was.</summary>
    private List<string> Ran()
    {
        var steps = LayoutMigrationPlan.Steps(_release);
        return
        [
            .. _runner.Calls
                .Where(call => call.Program == "/bin/sh")
                .Select(call => call.Arguments[1])
                .Select(script => steps.FirstOrDefault(step => step.Do == script) is { } done
                    ? done.Name
                    : steps.FirstOrDefault(step => step.Undo == script) is { } undone ? "undo " + undone.Name : null)
                .OfType<string>(),
        ];
    }

    private void Fail(string step, string error = "boom")
    {
        var script = LayoutMigrationPlan.Steps(_release).Single(s => s.Name == step).Do;
        _runner.Respond(spec => spec.Program == "/bin/sh" && spec.Arguments[1] == script, _ => FakeProcessRunner.Exit(1, error: error));
    }

    [Fact]
    public async Task A_migration_runs_every_step_and_records_it_done()
    {
        var exit = await Runner().StartAsync(_release, Cancel);

        Assert.Equal(LayoutMigrationExit.Done, exit);
        Assert.Equal(LayoutMigrationPlan.Steps(_release).Select(step => step.Name), Ran());
        var journal = _journal.Read()!;
        Assert.Equal(LayoutMigrationPhase.Done, journal.Phase);
        Assert.Equal(_release, journal.LegacyRelease);
        Assert.Equal(LayoutMigrationPlan.NewReleaseFor(_release), journal.NewRelease);
        Assert.Null(journal.Current);
        Assert.NotNull(journal.FinishedAt);
        // The old releases go a while later, from a timer: this run still reads its own file.
        var cleanup = LayoutMigrationPlan.Cleanup(journal.Id);
        Assert.Contains(_runner.Calls, call => call.Program == "/bin/sh" && call.Arguments[1] == cleanup);
        Assert.Contains("--on-active=120s", cleanup, StringComparison.Ordinal);
        Assert.Contains($"rm -rf -- {CoreLayout.Legacy.Releases} {CoreLayout.Legacy.Staging}", cleanup, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_failed_step_undoes_itself_and_everything_before_it_last_first()
    {
        Fail("data", "mv: cannot move: Device or resource busy");

        var exit = await Runner().StartAsync(_release, Cancel);

        Assert.Equal(LayoutMigrationExit.RolledBack, exit);
        Assert.Equal(
            ["release", "needrestart", "stop", "group", "data", "undo data", "undo group", "undo stop", "undo needrestart", "undo release"],
            Ran());
        var journal = _journal.Read()!;
        Assert.Equal(LayoutMigrationPhase.RolledBack, journal.Phase);
        Assert.Contains("Device or resource busy", journal.Error, StringComparison.Ordinal);
        Assert.Contains("busy", _journal.RolledBackError(), StringComparison.Ordinal);
        Assert.DoesNotContain(_runner.Calls, call => call.Program == "/bin/sh" && call.Arguments[1].Contains("cleanup-", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_new_core_that_does_not_answer_is_rolled_back()
    {
        _answers = false;

        var exit = await Runner().StartAsync(_release, Cancel);

        Assert.Equal(LayoutMigrationExit.RolledBack, exit);
        Assert.Equal("cutover", Ran()[7]);
        Assert.Equal("undo cutover", Ran()[8]);
        Assert.Equal("undo release", Ran()[^1]);
        Assert.Contains("does not answer", _journal.Read()!.Error, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_new_core_that_stops_is_rolled_back()
    {
        _runner.Respond("systemctl", ["is-active", "--quiet", CoreLayout.Runova.Unit], _ => FakeProcessRunner.Exit(3));

        var exit = await new LayoutMigrationRunner(_runner, _journal, TimeProvider.System, _ => Task.FromResult(true), _ => Task.FromResult<IReadOnlyList<string>>([]), _output)
        {
            Watch = TimeSpan.FromSeconds(5),
        }.StartAsync(_release, Cancel);

        Assert.Equal(LayoutMigrationExit.RolledBack, exit);
        Assert.Contains("did not stay up", _journal.Read()!.Error, StringComparison.Ordinal);
    }

    [Fact]
    public async Task An_undo_that_fails_too_leaves_a_failed_migration_with_both_reasons()
    {
        Fail("config", "config would not move");
        var undo = LayoutMigrationPlan.Steps(_release).Single(s => s.Name == "group").Undo;
        _runner.Respond(spec => spec.Program == "/bin/sh" && spec.Arguments[1] == undo, _ => FakeProcessRunner.Exit(1, error: "groupmod: group is busy"));

        var exit = await Runner().StartAsync(_release, Cancel);

        Assert.Equal(LayoutMigrationExit.Failed, exit);
        var journal = _journal.Read()!;
        Assert.Equal(LayoutMigrationPhase.Failed, journal.Phase);
        Assert.Contains("config would not move", journal.Error, StringComparison.Ordinal);
        Assert.Contains("groupmod: group is busy", journal.Error, StringComparison.Ordinal);
        // Every other undo still ran: the old core was started again.
        Assert.Contains("undo stop", Ran());
        Assert.Contains("undo release", Ran());
    }

    [Fact]
    public async Task A_resumed_migration_repeats_the_step_it_stopped_in_and_goes_on()
    {
        _journal.Write(new LayoutMigrationJournal
        {
            Id = Guid.NewGuid(),
            Phase = LayoutMigrationPhase.Running,
            LegacyRelease = _release,
            NewRelease = LayoutMigrationPlan.NewReleaseFor(_release),
            Completed = ["release", "needrestart", "stop", "group"],
            Current = "data",
            StartedAt = 1,
        });

        var exit = await Runner().ResumeAsync(Cancel);

        Assert.Equal(LayoutMigrationExit.Done, exit);
        Assert.Equal(["data", "config", "selinux", "cutover", "runtime", "compat", "finish"], Ran());
    }

    [Fact]
    public async Task A_rollback_on_request_undoes_what_the_journal_lists()
    {
        _journal.Write(new LayoutMigrationJournal
        {
            Id = Guid.NewGuid(),
            Phase = LayoutMigrationPhase.Running,
            LegacyRelease = _release,
            NewRelease = LayoutMigrationPlan.NewReleaseFor(_release),
            Completed = ["release", "needrestart", "stop"],
            Current = "group",
            StartedAt = 1,
        });

        var exit = await Runner().RollbackAsync(Cancel);

        Assert.Equal(LayoutMigrationExit.RolledBack, exit);
        Assert.Equal(["undo group", "undo stop", "undo needrestart", "undo release"], Ran());
    }

    [Fact]
    public async Task Nothing_runs_while_a_change_waits_for_its_confirmation_or_another_unit_runs()
    {
        _pending.Add("Firewall change \"open 8080\"");
        _runner.Respond("systemctl", ["list-units"], _ => FakeProcessRunner.Ok("runova-upgrade-0123456789abcdef0123456789abcdef.service loaded active running Upgrade\n"));

        var exit = await Runner().StartAsync(_release, Cancel);

        Assert.Equal(LayoutMigrationExit.Refused, exit);
        Assert.Empty(Ran());
        Assert.Null(_journal.Read());
        Assert.Contains("open 8080", _output.ToString(), StringComparison.Ordinal);
        Assert.Contains("runova-upgrade-0123456789abcdef0123456789abcdef.service is still running", _output.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_preflight_stops_a_migration_onto_folders_that_are_already_there()
    {
        _runner.Respond(
            spec => spec.Program == "/bin/sh" && spec.Arguments[1] == LayoutMigrationPlan.PreflightScript(),
            _ => FakeProcessRunner.Ok($"{CoreLayout.Runova.DataDirectory} is already there.\n"));

        Assert.Equal(LayoutMigrationExit.Refused, await Runner().StartAsync(_release, Cancel));
        Assert.Empty(Ran());
    }

    [Fact]
    public async Task A_second_start_is_refused_while_one_is_under_way()
    {
        _journal.Write(new LayoutMigrationJournal { Phase = LayoutMigrationPhase.Running, LegacyRelease = _release, NewRelease = "x" });

        Assert.Equal(LayoutMigrationExit.Refused, await Runner().StartAsync(_release, Cancel));
        Assert.Empty(Ran());
    }

    [Fact]
    public void The_status_reads_the_journal()
    {
        Assert.Equal(new LayoutMigrationStatus(CoreLayoutName.Legacy, LayoutMigrationPhase.None), _journal.Status(CoreLayout.Legacy));
        Assert.Equal(LayoutMigrationPhase.Done, _journal.Status(CoreLayout.Runova).Phase);

        _journal.Write(new LayoutMigrationJournal { Phase = LayoutMigrationPhase.Running, LegacyRelease = _release, NewRelease = "x", Current = "data", StartedAt = 5 });
        var status = _journal.Status(CoreLayout.Legacy);
        Assert.Equal(LayoutMigrationPhase.Running, status.Phase);
        Assert.Equal("Moving the state folder", status.Step);
        Assert.Equal(5, status.StartedAtUnixMs);
        Assert.Null(_journal.RolledBackError());
    }

    public void Dispose()
    {
        _output.Dispose();
        TestFolders.Delete(_folder);
    }
}
