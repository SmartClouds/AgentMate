using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Time.Testing;
using Runova.ServerCore.Alerts;
using Runova.ServerCore.Audit;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Hosting;
using Runova.ServerCore.Jobs;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Tests;

/// <summary>
/// Jobs: long-running work with a state in the database, a redacted log in a private file, locks
/// so two jobs never work on the same thing at once, cancellation, and a stream the app can leave
/// and pick up again after a reconnect without losing or repeating a line.
/// </summary>
public sealed class JobEngineTests : IAsyncLifetime
{
    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private readonly FakeTimeProvider _clock = new(DateTimeOffset.FromUnixTimeMilliseconds(1_800_000_000_000));

    private readonly string _data = TestFolders.Create("core-jobs");

    private TestDatabase _database = null!;

    private JobEngine _jobs = null!;

    private AlertCenter _alerts = null!;

    private static JobRequest Upgrade(bool cancellable = true) =>
        new(JobKind.PackagesUpgrade, "Upgrade all packages", ["packages"], RequestedByName: "maria", Cancellable: cancellable);

    public async ValueTask InitializeAsync()
    {
        _database = await TestDatabase.CreateAsync();
        var redactor = new Redactor();
        _alerts = new AlertCenter(_database.Contexts, _clock, redactor, NullLogger<AlertCenter>.Instance);
        _jobs = NewEngine();
    }

    private JobEngine NewEngine(long maxLogBytes = JobEngine.DefaultMaxLogBytes) => new(
        _database.Contexts,
        _clock,
        new Redactor(),
        new AuditLog(_database.Contexts, _clock, new Redactor()),
        _alerts,
        new CoreDirectories(_data),
        NullLogger<JobEngine>.Instance)
    {
        MaxLogBytes = maxLogBytes,
    };

    public async ValueTask DisposeAsync()
    {
        await _database.DisposeAsync();
        TestFolders.Delete(_data);
    }

    [Fact]
    public async Task A_job_runs_its_work_and_ends_succeeded()
    {
        var started = await _jobs.StartAsync(Upgrade(), (job, _) =>
        {
            job.Log("Reading package lists...", JobLogSource.Out);
            return Task.CompletedTask;
        }, Cancel);

        var finished = await _jobs.WhenFinishedAsync(started.Id, Cancel);

        Assert.Equal(JobState.Running, started.State);
        Assert.Equal(JobState.Succeeded, finished.State);
        Assert.Equal("maria", finished.RequestedBy);
        Assert.NotNull(finished.FinishedAtUnixMs);
        var stored = await _jobs.GetAsync(started.Id, Cancel);
        Assert.Equal(JobState.Succeeded, stored!.State);
        Assert.True(stored.LogLines >= 1);
    }

    [Fact]
    public async Task A_failing_job_records_why_and_raises_an_alert()
    {
        var started = await _jobs.StartAsync(Upgrade(), (_, _) =>
            throw new JobFailedException("apt-get exited with code 100.", exitCode: 100), Cancel);

        var finished = await _jobs.WhenFinishedAsync(started.Id, Cancel);

        Assert.Equal(JobState.Failed, finished.State);
        Assert.Equal(100, finished.ExitCode);
        Assert.Equal("apt-get exited with code 100.", finished.Error);
        var alert = Assert.Single(await _alerts.ListAsync(new AlertQuery(), Cancel));
        Assert.Equal(AlertKind.JobFailed, alert.Kind);
        Assert.Equal("packagesUpgrade", alert.Resource);
        Assert.Contains("Upgrade all packages", alert.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_later_success_of_the_same_kind_resolves_the_failure_alert()
    {
        var failed = await _jobs.StartAsync(Upgrade(), (_, _) => throw new JobFailedException("no"), Cancel);
        await _jobs.WhenFinishedAsync(failed.Id, Cancel);
        var succeeded = await _jobs.StartAsync(Upgrade(), (_, _) => Task.CompletedTask, Cancel);
        await _jobs.WhenFinishedAsync(succeeded.Id, Cancel);

        Assert.Empty(await _alerts.ListAsync(new AlertQuery(), Cancel));
    }

    [Fact]
    public async Task An_unexpected_error_fails_the_job_without_leaking_the_details()
    {
        var started = await _jobs.StartAsync(Upgrade(), (_, _) =>
            throw new InvalidOperationException("token=abcdef0123456789 leaked"), Cancel);

        var finished = await _jobs.WhenFinishedAsync(started.Id, Cancel);

        Assert.Equal(JobState.Failed, finished.State);
        Assert.DoesNotContain("abcdef0123456789", finished.Error, StringComparison.Ordinal);
        Assert.DoesNotContain("abcdef0123456789", await File.ReadAllTextAsync(_jobs.LogPath(started.Id), Cancel), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Cancelling_a_running_job_cancels_its_work()
    {
        var started = await _jobs.StartAsync(Upgrade(), (_, token) => Task.Delay(Timeout.Infinite, token), Cancel);

        var accepted = _jobs.Cancel(started.Id);
        var finished = await _jobs.WhenFinishedAsync(started.Id, Cancel);

        Assert.True(accepted);
        Assert.Equal(JobState.Cancelled, finished.State);
        Assert.False(_jobs.Cancel(started.Id));
        // A cancellation is a person's decision, not a failure to report.
        Assert.Empty(await _alerts.ListAsync(new AlertQuery(), Cancel));
    }

    [Fact]
    public async Task A_job_that_cannot_be_stopped_refuses_to_cancel()
    {
        var release = new TaskCompletionSource();
        var started = await _jobs.StartAsync(Upgrade(cancellable: false), (_, _) => release.Task, Cancel);

        Assert.False(_jobs.Cancel(started.Id));
        release.SetResult();
        Assert.Equal(JobState.Succeeded, (await _jobs.WhenFinishedAsync(started.Id, Cancel)).State);
    }

    [Fact]
    public async Task Jobs_on_the_same_resource_never_run_at_once()
    {
        var release = new TaskCompletionSource();
        var first = await _jobs.StartAsync(Upgrade(), (_, _) => release.Task, Cancel);

        var conflict = await Assert.ThrowsAsync<JobConflictException>(() =>
            _jobs.StartAsync(Upgrade() with { Kind = JobKind.PackagesUpgradeSecurity }, (_, _) => Task.CompletedTask, Cancel));
        var elsewhere = await _jobs.StartAsync(
            new JobRequest(JobKind.ServiceRestart, "Restart nginx", ["service:nginx"]),
            (_, _) => Task.CompletedTask,
            Cancel);
        release.SetResult();
        await _jobs.WhenFinishedAsync(first.Id, Cancel);
        var after = await _jobs.StartAsync(Upgrade(), (_, _) => Task.CompletedTask, Cancel);

        Assert.Equal(first.Id, conflict.Holder.Id);
        Assert.Equal("packages", conflict.Lock);
        Assert.Equal(JobState.Succeeded, (await _jobs.WhenFinishedAsync(elsewhere.Id, Cancel)).State);
        Assert.Equal(JobState.Succeeded, (await _jobs.WhenFinishedAsync(after.Id, Cancel)).State);
    }

    [Fact]
    public async Task The_log_is_redacted_before_it_is_written()
    {
        var started = await _jobs.StartAsync(Upgrade(), (job, _) =>
        {
            job.Seed(["seeded-registry-secret"]);
            job.Log("DB_PASSWORD=hunter2hunter2", JobLogSource.Out);
            job.Log("login with seeded-registry-secret", JobLogSource.Err);
            return Task.CompletedTask;
        }, Cancel);
        await _jobs.WhenFinishedAsync(started.Id, Cancel);

        var file = await File.ReadAllTextAsync(_jobs.LogPath(started.Id), Cancel);
        var lines = await ReadAllLinesAsync(started.Id, 0);

        Assert.DoesNotContain("hunter2", file, StringComparison.Ordinal);
        Assert.DoesNotContain("seeded-registry-secret", file, StringComparison.Ordinal);
        Assert.Contains(lines, line => line.Text == "DB_PASSWORD=[redacted]" && line.Source == JobLogSource.Out);
        Assert.Contains(lines, line => line.Text == "login with [redacted]" && line.Source == JobLogSource.Err);
    }

    [Fact]
    public async Task Log_files_are_readable_by_root_alone()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "Unix file modes");
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        var started = await _jobs.StartAsync(Upgrade(), (job, _) =>
        {
            job.Log("hello");
            return Task.CompletedTask;
        }, Cancel);
        await _jobs.WhenFinishedAsync(started.Id, Cancel);

        Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(_jobs.LogPath(started.Id)));
        Assert.Equal(
            UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute,
            File.GetUnixFileMode(Path.GetDirectoryName(_jobs.LogPath(started.Id))!));
    }

    [Fact]
    public async Task A_log_stops_growing_at_its_size_limit_and_says_so()
    {
        var jobs = NewEngine(maxLogBytes: 4096);
        var started = await jobs.StartAsync(Upgrade(), (job, _) =>
        {
            for (var i = 0; i < 1000; i++)
            {
                job.Log($"line {i} of a chatty program", JobLogSource.Out);
            }

            return Task.CompletedTask;
        }, Cancel);
        await jobs.WhenFinishedAsync(started.Id, Cancel);

        Assert.InRange(new FileInfo(jobs.LogPath(started.Id)).Length, 1, 4096 + 1024);
        var lines = await ReadAllLinesAsync(started.Id, 0, jobs);
        Assert.Contains(lines, line => line.Source == JobLogSource.System && line.Text.Contains("size limit", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_finished_job_streams_its_whole_log_then_its_final_state()
    {
        var started = await _jobs.StartAsync(Upgrade(), (job, _) =>
        {
            for (var i = 1; i <= 3; i++)
            {
                job.Log($"step {i}", JobLogSource.Out);
            }

            return Task.CompletedTask;
        }, Cancel);
        await _jobs.WhenFinishedAsync(started.Id, Cancel);

        var items = await CollectAsync(_jobs.StreamAsync(started.Id, 0, Cancel));

        Assert.NotNull(items[0].Job);
        Assert.Equal(JobState.Succeeded, items[^1].Job!.State);
        var lines = items.SelectMany(item => item.Lines).ToList();
        Assert.Equal(Enumerable.Range(1, lines.Count).Select(i => (long)i), lines.Select(line => line.Seq));
        Assert.Contains(lines, line => line.Text == "step 3");
    }

    [Fact]
    public async Task A_reconnecting_client_resumes_after_its_last_line_without_repeats()
    {
        var more = new TaskCompletionSource();
        var done = new TaskCompletionSource();
        var started = await _jobs.StartAsync(Upgrade(), async (job, _) =>
        {
            job.Log("one", JobLogSource.Out);
            job.Log("two", JobLogSource.Out);
            await more.Task;
            job.Log("three", JobLogSource.Out);
            job.Log("four", JobLogSource.Out);
            await done.Task;
        }, Cancel);

        // The first connection reads what is there so far, then drops.
        var seen = new List<JobLogLine>();
        using (var firstConnection = CancellationTokenSource.CreateLinkedTokenSource(Cancel))
        {
            await foreach (var item in _jobs.StreamAsync(started.Id, 0, firstConnection.Token))
            {
                seen.AddRange(item.Lines);
                if (seen.Any(line => line.Text == "two"))
                {
                    break;
                }
            }
        }

        more.SetResult();
        var resumeFrom = seen.Max(line => line.Seq);
        var resumed = new List<JobStreamItem>();
        var reading = Task.Run(async () =>
        {
            await foreach (var item in _jobs.StreamAsync(started.Id, resumeFrom, Cancel))
            {
                resumed.Add(item);
                if (item.Lines.Any(line => line.Text == "four"))
                {
                    done.TrySetResult();
                }
            }
        }, Cancel);
        await reading.WaitAsync(TimeSpan.FromSeconds(10), Cancel);

        var all = seen.Concat(resumed.SelectMany(item => item.Lines)).ToList();
        Assert.Equal(Enumerable.Range(1, all.Count).Select(i => (long)i), all.Select(line => line.Seq));
        Assert.Equal(1, all.Count(line => line.Text == "two"));
        Assert.Equal(1, all.Count(line => line.Text == "three"));
        Assert.Equal(JobState.Succeeded, resumed[^1].Job!.State);
    }

    [Fact]
    public async Task Streaming_a_job_that_does_not_exist_is_refused()
    {
        await Assert.ThrowsAsync<KeyNotFoundException>(async () =>
            await CollectAsync(_jobs.StreamAsync(Guid.NewGuid(), 0, Cancel)));
    }

    [Fact]
    public async Task Jobs_a_previous_core_left_running_are_marked_interrupted()
    {
        await using (var db = await _database.Contexts.CreateDbContextAsync(Cancel))
        {
            db.Jobs.Add(new Job
            {
                Id = Guid.NewGuid(),
                Kind = JobKind.PackagesUpgrade,
                Title = "Upgrade all packages",
                State = JobState.Running,
                CreatedAt = _clock.GetUtcNow().ToUnixTimeMilliseconds(),
                Cancellable = true,
            });
            await db.SaveChangesAsync(Cancel);
        }

        var recovered = await _jobs.RecoverAsync(Cancel);

        Assert.Equal(1, recovered);
        var job = Assert.Single((await _jobs.ListAsync(new JobQuery(), Cancel)).Jobs);
        Assert.Equal(JobState.Interrupted, job.State);
        Assert.NotNull(job.Error);
    }

    [Fact]
    public async Task Jobs_are_listed_newest_first_a_page_at_a_time()
    {
        var ids = new List<Guid>();
        for (var i = 0; i < 3; i++)
        {
            var job = await _jobs.StartAsync(Upgrade(), (_, _) => Task.CompletedTask, Cancel);
            await _jobs.WhenFinishedAsync(job.Id, Cancel);
            ids.Add(job.Id);
            _clock.Advance(TimeSpan.FromSeconds(1));
        }

        var first = await _jobs.ListAsync(new JobQuery(Limit: 2), Cancel);
        var second = await _jobs.ListAsync(new JobQuery(Limit: 2, BeforeCreatedAtUnixMs: first.NextBeforeCreatedAtUnixMs), Cancel);

        Assert.Equal([ids[2], ids[1]], first.Jobs.Select(job => job.Id));
        Assert.Equal([ids[0]], second.Jobs.Select(job => job.Id));
        Assert.Null(second.NextBeforeCreatedAtUnixMs);
    }

    [Fact]
    public async Task Old_finished_jobs_go_with_their_logs()
    {
        var old = await _jobs.StartAsync(Upgrade(), (job, _) =>
        {
            job.Log("old");
            return Task.CompletedTask;
        }, Cancel);
        await _jobs.WhenFinishedAsync(old.Id, Cancel);
        _clock.Advance(TimeSpan.FromDays(40));
        var recent = await _jobs.StartAsync(Upgrade(), (_, _) => Task.CompletedTask, Cancel);
        await _jobs.WhenFinishedAsync(recent.Id, Cancel);

        var pruned = await _jobs.PruneAsync(_clock.GetUtcNow() - JobEngine.Keep, Cancel);

        Assert.Equal(1, pruned);
        Assert.Null(await _jobs.GetAsync(old.Id, Cancel));
        Assert.False(File.Exists(_jobs.LogPath(old.Id)));
        Assert.NotNull(await _jobs.GetAsync(recent.Id, Cancel));
    }

    [Fact]
    public async Task Every_job_leaves_a_trace_in_the_audit_trail_when_it_ends()
    {
        var started = await _jobs.StartAsync(Upgrade(), (_, _) => Task.CompletedTask, Cancel);
        await _jobs.WhenFinishedAsync(started.Id, Cancel);

        await using var db = await _database.Contexts.CreateDbContextAsync(Cancel);
        var finished = await db.AuditEvents.SingleAsync(e => e.Action == "job.finished", Cancel);
        Assert.Equal(started.Id.ToString("D"), finished.Target);
        Assert.Equal(AuditResult.Success, finished.Result);
    }

    private async Task<List<JobLogLine>> ReadAllLinesAsync(Guid id, long afterSeq, JobEngine? jobs = null) =>
        [.. (await CollectAsync((jobs ?? _jobs).StreamAsync(id, afterSeq, Cancel))).SelectMany(item => item.Lines)];

    private static async Task<List<JobStreamItem>> CollectAsync(IAsyncEnumerable<JobStreamItem> stream)
    {
        var items = new List<JobStreamItem>();
        await foreach (var item in stream.WithCancellation(Cancel))
        {
            items.Add(item);
        }

        return items;
    }
}
