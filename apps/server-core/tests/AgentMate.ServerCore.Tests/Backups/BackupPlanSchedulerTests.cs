using AgentMate.ServerCore.Backups;
using AgentMate.ServerCore.Data;
using Hangfire;
using Hangfire.Storage;
using Hangfire.Storage.SQLite;

namespace AgentMate.ServerCore.Tests.Backups;

/// <summary>
/// Plans become Hangfire recurring jobs (E28), in Hangfire's own SQLite file, and the core puts the
/// two back in step at start: a job for every enabled plan, none for anything else.
/// </summary>
public sealed class BackupPlanSchedulerTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("am-hangfire-").FullName;
    private readonly SQLiteStorage _storage;
    private readonly BackupPlanScheduler _scheduler;

    public BackupPlanSchedulerTests()
    {
        _storage = new SQLiteStorage(Path.Combine(_root, "hangfire.db"), new SQLiteStorageOptions());
        _scheduler = new BackupPlanScheduler(new RecurringJobManager(_storage), _storage);
    }

    public void Dispose()
    {
        _storage.Dispose();
        try
        {
            Directory.Delete(_root, recursive: true);
        }
        catch (IOException)
        {
            // SQLite on Windows can hold the file a moment longer; the temp folder is swept anyway.
        }
    }

    private static BackupPlanRecord Plan(bool enabled = true, string cron = "0 3 * * *") => new()
    {
        Id = Guid.NewGuid(),
        Name = "Nightly",
        Enabled = enabled,
        Cron = cron,
        TimeZone = "UTC",
        KeepLast = 7,
    };

    private List<RecurringJobDto> Jobs()
    {
        using var connection = _storage.GetConnection();
        return connection.GetRecurringJobs();
    }

    [Fact]
    public void An_enabled_plan_is_a_recurring_job_with_its_schedule()
    {
        var plan = Plan();

        _scheduler.Apply(plan);

        var job = Assert.Single(Jobs());
        Assert.Equal(BackupPlanScheduler.RecurringId(plan.Id), job.Id);
        Assert.Equal("0 3 * * *", job.Cron);
        Assert.Equal("UTC", job.TimeZoneId);
        Assert.Equal(nameof(BackupRunner.RunPlanAsync), job.Job.Method.Name);
        Assert.Equal(plan.Id, job.Job.Args[0]);
    }

    [Fact]
    public void A_disabled_or_deleted_plan_has_none()
    {
        var plan = Plan();
        _scheduler.Apply(plan);

        plan.Enabled = false;
        _scheduler.Apply(plan);
        Assert.Empty(Jobs());

        plan.Enabled = true;
        _scheduler.Apply(plan);
        _scheduler.Remove(plan.Id);
        Assert.Empty(Jobs());
    }

    [Fact]
    public void Starting_up_adds_what_is_missing_and_drops_what_has_no_plan()
    {
        var kept = Plan();
        var missing = Plan(cron: "0 */6 * * *");
        var disabled = Plan(enabled: false);
        _scheduler.Apply(kept);
        new RecurringJobManager(_storage).AddOrUpdate<BackupRunner>(
            BackupPlanScheduler.RecurringId(Guid.NewGuid()),
            runner => runner.RunPlanAsync(Guid.Empty, CancellationToken.None),
            "0 0 * * *");
        new RecurringJobManager(_storage).AddOrUpdate<BackupRunner>(
            "something-else",
            runner => runner.RunPlanAsync(Guid.Empty, CancellationToken.None),
            "0 0 * * *");

        _scheduler.Reconcile([kept, missing, disabled]);

        Assert.Equal(
            new[] { BackupPlanScheduler.RecurringId(kept.Id), BackupPlanScheduler.RecurringId(missing.Id), "something-else" }.Order(),
            Jobs().Select(job => job.Id).Order());
    }

    [Theory]
    [InlineData("61 * * * *", "UTC", "schedule")]
    [InlineData("not cron", "UTC", "schedule")]
    [InlineData("*/5 * * * *", "UTC", "15 minutes")]
    [InlineData("0 3 * * *", "Mars/Olympus_Mons", "time zone")]
    public void A_schedule_that_will_not_do_is_refused(string cron, string timeZone, string problem)
    {
        Assert.Contains(problem, BackupPlanScheduler.ScheduleProblem(cron, timeZone), StringComparison.Ordinal);
    }

    [Fact]
    public void A_fine_schedule_has_no_problem_and_its_next_runs_are_known()
    {
        var from = DateTimeOffset.Parse("2026-10-22T05:00:00Z", System.Globalization.CultureInfo.InvariantCulture);

        Assert.Null(BackupPlanScheduler.ScheduleProblem("0 3 * * *", "UTC"));
        var runs = BackupPlanScheduler.NextRuns("0 3 * * *", "UTC", from, 3);

        Assert.Equal(
            new[] { "2026-10-23T03:00:00Z", "2026-10-24T03:00:00Z", "2026-10-25T03:00:00Z" },
            runs.Select(run => DateTimeOffset.FromUnixTimeMilliseconds(run).ToString("yyyy-MM-ddTHH:mm:ssZ", System.Globalization.CultureInfo.InvariantCulture)));
    }
}
