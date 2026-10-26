using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Runova.ServerCore.Alerts;
using Runova.ServerCore.Audit;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Hosting;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Jobs;

/// <summary>
/// What to run. Locks name what the job works on ("packages", "power", "service:nginx"): no two
/// running jobs ever share one.
/// </summary>
internal sealed record JobRequest(
    JobKind Kind,
    string Title,
    IReadOnlyList<string> Locks,
    string? Resource = null,
    Guid? RequestedBy = null,
    string? RequestedByName = null,
    bool Cancellable = true);

/// <summary>The work of a job. The token is cancelled when someone cancels the job.</summary>
internal delegate Task JobWork(JobContext job, CancellationToken cancellationToken);

/// <summary>The work failed in a way worth telling the person: the message is shown, redacted.</summary>
internal sealed class JobFailedException(string message, int? exitCode = null) : Exception(message)
{
    public int? ExitCode { get; } = exitCode;
}

/// <summary>Another running job holds one of the locks this one needs.</summary>
internal sealed class JobConflictException(string lockName, JobInfo holder)
    : Exception($"Another job is already working on {lockName}: {holder.Title}.")
{
    public string Lock { get; } = lockName;

    public JobInfo Holder { get; } = holder;
}

/// <summary>What a job's work can do: write to its log (always redacted) and learn its unit name.</summary>
internal sealed class JobContext
{
    private readonly JobLogWriter _log;
    private readonly Lock _gate = new();
    private LineRedactor _lines;
    private Redactor _redactor;

    internal JobContext(Guid id, JobKind kind, JobLogWriter log, Redactor redactor)
    {
        Id = id;
        Kind = kind;
        _log = log;
        _redactor = redactor;
        _lines = new LineRedactor(redactor);
        Output = line => Log(line.Text, line.Stream == OutputStream.Err ? JobLogSource.Err : JobLogSource.Out);
    }

    public Guid Id { get; }

    public JobKind Kind { get; }

    /// <summary>
    /// The transient unit for one step of this job (`runova-upgrade-&lt;job&gt;`). Each step has a
    /// name of its own: a collected unit's name is not always free again the moment it stops.
    /// </summary>
    public string UnitFor(string step) => SystemdRunner.UnitName(step, Id);

    /// <summary>Hands a program's output lines to the log.</summary>
    public Action<OutputLine> Output { get; }

    /// <summary>How many lines the log has so far, so work can say which lines a step wrote.</summary>
    public long LogLines
    {
        get
        {
            lock (_gate)
            {
                return _log.Count;
            }
        }
    }

    /// <summary>Set by work that ran a program, so the job records how it ended.</summary>
    public int? ExitCode { get; set; }

    internal Redactor Redactor
    {
        get
        {
            lock (_gate)
            {
                return _redactor;
            }
        }
    }

    public void Log(string text, JobLogSource source = JobLogSource.System)
    {
        ArgumentNullException.ThrowIfNull(text);
        lock (_gate)
        {
            _log.Append(source, _lines.Redact(text));
        }
    }

    /// <summary>Values this job must never show (a token it was handed), masked from here on.</summary>
    public void Seed(IEnumerable<string?> secrets)
    {
        lock (_gate)
        {
            _redactor = _redactor.With(secrets);
            _lines = new LineRedactor(_redactor);
        }
    }
}

/// <summary>
/// Runs jobs: the row in the database, the log file, locks, cancellation, the audit trail and the
/// alert a failure raises. A job's stream reads its log file, so a client can leave and come back
/// with the last line number it saw and carry on without a gap or a repeat.
/// </summary>
internal sealed partial class JobEngine(
    IDbContextFactory<CoreDbContext> contexts,
    TimeProvider time,
    Redactor redactor,
    AuditLog audit,
    AlertCenter alerts,
    CoreDirectories directories,
    ILogger<JobEngine> logger) : IHostedService
{
    public const long DefaultMaxLogBytes = 8 * 1024 * 1024;

    public const int MaxPage = 200;

    /// <summary>How long finished jobs and their logs are kept.</summary>
    public static readonly TimeSpan Keep = TimeSpan.FromDays(30);

    private const int BatchLines = 200;
    private const int BatchChars = 32 * 1024;
    private const int MaxErrorLength = 500;

    private readonly ConcurrentDictionary<Guid, RunningJob> _running = new();
    private readonly Lock _locksGate = new();
    private readonly Dictionary<string, Guid> _locks = new(StringComparer.Ordinal);

    public long MaxLogBytes { get; init; } = DefaultMaxLogBytes;

    private long Now => time.GetUtcNow().ToUnixTimeMilliseconds();

    public string LogPath(Guid id) => Path.Combine(directories.Jobs, $"{id:N}.log");

    /// <summary>The running job holding a lock, if any (the Overview shows it instead of a second button).</summary>
    public JobInfo? Holder(string lockName)
    {
        lock (_locksGate)
        {
            return _locks.TryGetValue(lockName, out var id) && _running.TryGetValue(id, out var job) ? job.Snapshot() : null;
        }
    }

    public async Task<JobInfo> StartAsync(JobRequest request, JobWork work, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(work);
        if (!Enum.IsDefined(request.Kind) || string.IsNullOrWhiteSpace(request.Title) || request.Title.Length > 200)
        {
            throw new ArgumentException("A job needs a known kind and a short title.", nameof(request));
        }

        var id = Guid.NewGuid();
        AcquireLocks(id, request.Locks);
        try
        {
            var row = new Job
            {
                Id = id,
                Kind = request.Kind,
                Title = request.Title,
                State = JobState.Running,
                Resource = request.Resource,
                RequestedBy = request.RequestedBy,
                RequestedByName = request.RequestedByName,
                CreatedAt = Now,
                Cancellable = request.Cancellable,
            };
            await using (var db = await contexts.CreateDbContextAsync(cancellationToken))
            {
                db.Jobs.Add(row);
                await db.SaveChangesAsync(cancellationToken);
            }

            directories.EnsureJobs();
            var pulse = new Pulse();
            var log = JobLogWriter.Create(LogPath(id), MaxLogBytes, time, pulse.Fire);
            var job = new RunningJob(row, log, pulse);
            _running[id] = job;
            var context = new JobContext(id, request.Kind, log, redactor);
            context.Log(request.RequestedByName is { Length: > 0 } name
                ? $"{request.Title}: started by {name}."
                : $"{request.Title}: started.");
            _ = Task.Run(() => RunAsync(job, context, work), CancellationToken.None);
            return job.Snapshot();
        }
        catch
        {
            ReleaseLocks(id);
            throw;
        }
    }

    /// <summary>Asks a running job to stop. False when it is not running or cannot be stopped.</summary>
    public bool Cancel(Guid id)
    {
        if (!_running.TryGetValue(id, out var job) || !job.Row.Cancellable || job.IsFinished)
        {
            return false;
        }

        job.Cancellation.Cancel();
        return true;
    }

    public async Task<JobInfo?> GetAsync(Guid id, CancellationToken cancellationToken = default)
    {
        if (_running.TryGetValue(id, out var running))
        {
            return running.Snapshot();
        }

        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var row = await db.Jobs.AsNoTracking().FirstOrDefaultAsync(j => j.Id == id, cancellationToken);
        return row is null ? null : ToInfo(row, row.LogLines);
    }

    /// <summary>The job's final state once it has one.</summary>
    public async Task<JobInfo> WhenFinishedAsync(Guid id, CancellationToken cancellationToken = default)
    {
        if (_running.TryGetValue(id, out var running))
        {
            return await running.Finished.Task.WaitAsync(cancellationToken);
        }

        return await GetAsync(id, cancellationToken) ?? throw new KeyNotFoundException($"There is no job {id}.");
    }

    public async Task<JobPage> ListAsync(JobQuery query, CancellationToken cancellationToken = default)
    {
        var limit = Math.Clamp(query?.Limit ?? 50, 1, MaxPage);
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var rows = db.Jobs.AsNoTracking();
        if (query?.BeforeCreatedAtUnixMs is long before)
        {
            rows = rows.Where(j => j.CreatedAt < before);
        }

        if (query?.ActiveOnly == true)
        {
            rows = rows.Where(j => j.State == JobState.Running);
        }

        var page = await rows.OrderByDescending(j => j.CreatedAt).Take(limit + 1).ToListAsync(cancellationToken);
        var shown = page.Take(limit)
            .Select(row => _running.TryGetValue(row.Id, out var running) ? running.Snapshot() : ToInfo(row, row.LogLines))
            .ToArray();
        return new JobPage(shown, page.Count > limit ? shown[^1].CreatedAtUnixMs : null);
    }

    /// <summary>
    /// The log after line <paramref name="afterSeq"/>, then new lines as they come, then the final
    /// state. The first item carries the job; the last carries its final state.
    /// </summary>
    public async IAsyncEnumerable<JobStreamItem> StreamAsync(
        Guid id,
        long afterSeq,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        _running.TryGetValue(id, out var running);
        var stored = running is null ? await GetAsync(id, cancellationToken) : null;
        if (running is null && stored is null)
        {
            throw new KeyNotFoundException($"There is no job {id}.");
        }

        using var reader = new JobLogReader(LogPath(id));
        var sentJob = false;
        var last = Math.Max(0, afterSeq);
        while (true)
        {
            // Taken before reading, so a line written after the read still wakes the wait below.
            var wait = running?.Pulse.Next;
            var finished = running is null || running.IsFinished;
            var fresh = (await reader.ReadNewAsync(cancellationToken)).Where(line => line.Seq > last).ToList();
            foreach (var batch in Batches(fresh))
            {
                yield return new JobStreamItem([.. batch], sentJob ? null : running?.Snapshot() ?? stored);
                sentJob = true;
                last = batch[^1].Seq;
            }

            if (finished)
            {
                yield return new JobStreamItem([], running?.Final ?? stored);
                yield break;
            }

            if (!sentJob)
            {
                yield return new JobStreamItem([], running!.Snapshot());
                sentJob = true;
            }

            await wait!.WaitAsync(cancellationToken);
        }
    }

    /// <summary>Jobs a previous core left running: whatever they were doing, nobody is watching them now.</summary>
    public async Task<int> RecoverAsync(CancellationToken cancellationToken)
    {
        var now = Now;
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var recovered = await db.Jobs
            .Where(j => j.State == JobState.Running)
            .ExecuteUpdateAsync(
                update => update
                    .SetProperty(j => j.State, JobState.Interrupted)
                    .SetProperty(j => j.FinishedAt, now)
                    .SetProperty(j => j.Error, "The core stopped while this job ran. The work may have finished on its own; check before running it again."),
                cancellationToken);
        if (recovered > 0)
        {
            LogRecovered(logger, recovered);
        }

        return recovered;
    }

    /// <summary>Finished jobs created before the cutoff, with their logs.</summary>
    public async Task<int> PruneAsync(DateTimeOffset cutoff, CancellationToken cancellationToken)
    {
        var cutoffMs = cutoff.ToUnixTimeMilliseconds();
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var old = await db.Jobs
            .Where(j => j.CreatedAt < cutoffMs && j.State != JobState.Running)
            .Select(j => j.Id)
            .ToListAsync(cancellationToken);
        foreach (var id in old)
        {
            try
            {
                File.Delete(LogPath(id));
            }
            catch (IOException error)
            {
                LogPruneFailed(logger, id, error);
            }
        }

        return await db.Jobs.Where(j => old.Contains(j.Id)).ExecuteDeleteAsync(cancellationToken);
    }

    Task IHostedService.StartAsync(CancellationToken cancellationToken) => RecoverAsync(cancellationToken);

    /// <summary>
    /// The core is stopping. Running jobs are recorded as interrupted and left alone: work in a
    /// transient unit carries on without the core, and stopping it here could cut an upgrade short.
    /// </summary>
    async Task IHostedService.StopAsync(CancellationToken cancellationToken)
    {
        var ids = _running.Keys.ToList();
        if (ids.Count == 0)
        {
            return;
        }

        try
        {
            var now = Now;
            await using var db = await contexts.CreateDbContextAsync(cancellationToken);
            await db.Jobs
                .Where(j => ids.Contains(j.Id) && j.State == JobState.Running)
                .ExecuteUpdateAsync(
                    update => update
                        .SetProperty(j => j.State, JobState.Interrupted)
                        .SetProperty(j => j.FinishedAt, now)
                        .SetProperty(j => j.Error, "The core stopped while this job ran."),
                    cancellationToken);
        }
        catch (Exception error) when (error is not OutOfMemoryException)
        {
            LogStopFailed(logger, error);
        }
    }

    private async Task RunAsync(RunningJob job, JobContext context, JobWork work)
    {
        var state = JobState.Succeeded;
        string? error = null;
        int? exitCode = null;
        try
        {
            await work(context, job.Cancellation.Token);
            exitCode = context.ExitCode;
            context.Log("Done.");
        }
        catch (OperationCanceledException) when (job.Cancellation.IsCancellationRequested)
        {
            state = JobState.Cancelled;
            context.Log("Cancelled.");
        }
        catch (JobFailedException failure)
        {
            state = JobState.Failed;
            error = Clip(context.Redactor.Redact(failure.Message));
            exitCode = failure.ExitCode ?? context.ExitCode;
            context.Log($"Failed: {error}");
        }
        catch (Exception unexpected)
        {
            state = JobState.Failed;
            error = "The job stopped on an unexpected error. The core's journal has the details.";
            LogUnexpected(logger, job.Row.Id, unexpected);
            context.Log($"Failed: {error}");
        }

        await FinishAsync(job, state, error, exitCode);
    }

    private async Task FinishAsync(RunningJob job, JobState state, string? error, int? exitCode)
    {
        job.Log.Dispose();
        var finishedAt = Now;
        var final = ToInfo(job.Row, job.Log.Count) with
        {
            State = state,
            FinishedAtUnixMs = finishedAt,
            ExitCode = exitCode,
            Error = error,
            Cancellable = false,
        };

        try
        {
            await using var db = await contexts.CreateDbContextAsync();
            await db.Jobs
                .Where(j => j.Id == job.Row.Id)
                .ExecuteUpdateAsync(update => update
                    .SetProperty(j => j.State, state)
                    .SetProperty(j => j.FinishedAt, finishedAt)
                    .SetProperty(j => j.ExitCode, exitCode)
                    .SetProperty(j => j.Error, error)
                    .SetProperty(j => j.LogLines, job.Log.Count));
            await audit.AppendAsync(new AuditEntry(
                "job.finished",
                state switch
                {
                    JobState.Succeeded => AuditResult.Success,
                    JobState.Cancelled => AuditResult.Cancelled,
                    _ => AuditResult.Failed,
                },
                job.Row.RequestedBy,
                Target: job.Row.Id.ToString("D"),
                Parameters: new Dictionary<string, string?> { ["kind"] = KindName(job.Row.Kind), ["state"] = KindName(state) }));
            await ReportAsync(job, state, error);
        }
        catch (Exception failure) when (failure is not OutOfMemoryException)
        {
            // The host may be shutting down; the next start marks the row interrupted if it stayed running.
            LogFinishFailed(logger, job.Row.Id, failure);
        }

        job.Final = final;
        job.IsFinished = true;
        ReleaseLocks(job.Row.Id);
        _running.TryRemove(job.Row.Id, out _);
        job.Finished.TrySetResult(final);
        job.Pulse.Fire();
    }

    /// <summary>A failure raises an alert per kind of job; the next success of that kind resolves it.</summary>
    private async Task ReportAsync(RunningJob job, JobState state, string? error)
    {
        var resource = KindName(job.Row.Kind);
        if (state == JobState.Failed)
        {
            await alerts.RaiseAsync(AlertKind.JobFailed, resource, AlertSeverity.Warning, $"{job.Row.Title} failed: {error}");
        }
        else if (state == JobState.Succeeded)
        {
            await alerts.ResolveAsync(AlertKind.JobFailed, resource);
        }
    }

    private void AcquireLocks(Guid id, IReadOnlyList<string> locks)
    {
        lock (_locksGate)
        {
            foreach (var name in locks)
            {
                if (_locks.TryGetValue(name, out var holder))
                {
                    var holderInfo = _running.TryGetValue(holder, out var job) ? job.Snapshot() : null;
                    throw new JobConflictException(name, holderInfo ?? new JobInfo(holder, JobKind.PackagesRefresh, "another job", JobState.Running, 0, 0, false));
                }
            }

            foreach (var name in locks)
            {
                _locks[name] = id;
            }
        }
    }

    private void ReleaseLocks(Guid id)
    {
        lock (_locksGate)
        {
            foreach (var name in _locks.Where(entry => entry.Value == id).Select(entry => entry.Key).ToList())
            {
                _locks.Remove(name);
            }
        }
    }

    private static IEnumerable<List<JobLogLine>> Batches(List<JobLogLine> lines)
    {
        var batch = new List<JobLogLine>();
        var chars = 0;
        foreach (var line in lines)
        {
            if (batch.Count > 0 && (batch.Count >= BatchLines || chars + line.Text.Length > BatchChars))
            {
                yield return batch;
                batch = [];
                chars = 0;
            }

            batch.Add(line);
            chars += line.Text.Length;
        }

        if (batch.Count > 0)
        {
            yield return batch;
        }
    }

    internal static string KindName<T>(T value)
        where T : struct, Enum => JsonNamingPolicy.CamelCase.ConvertName(value.ToString());

    private static JobInfo ToInfo(Job row, long logLines) => new(
        row.Id,
        row.Kind,
        row.Title,
        row.State,
        row.CreatedAt,
        logLines,
        row.Cancellable && row.State == JobState.Running,
        row.Resource,
        row.RequestedByName,
        row.FinishedAt,
        row.ExitCode,
        row.Error);

    private static string Clip(string text) => text.Length <= MaxErrorLength ? text : text[..(MaxErrorLength - 1)] + "…";

    [LoggerMessage(Level = LogLevel.Warning, Message = "Marked {Count} jobs interrupted: they were running when the core last stopped.")]
    private static partial void LogRecovered(ILogger logger, int count);

    [LoggerMessage(Level = LogLevel.Error, Message = "Job {JobId} stopped on an unexpected error.")]
    private static partial void LogUnexpected(ILogger logger, Guid jobId, Exception error);

    [LoggerMessage(Level = LogLevel.Error, Message = "Could not record the end of job {JobId}.")]
    private static partial void LogFinishFailed(ILogger logger, Guid jobId, Exception error);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Could not record the running jobs as interrupted while stopping.")]
    private static partial void LogStopFailed(ILogger logger, Exception error);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Could not delete the log of job {JobId}.")]
    private static partial void LogPruneFailed(ILogger logger, Guid jobId, Exception error);

    private sealed class RunningJob(Job row, JobLogWriter log, Pulse pulse)
    {
        public Job Row { get; } = row;

        public JobLogWriter Log { get; } = log;

        public Pulse Pulse { get; } = pulse;

        public CancellationTokenSource Cancellation { get; } = new();

        private volatile bool _finished;

        public TaskCompletionSource<JobInfo> Finished { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public bool IsFinished
        {
            get => _finished;
            set => _finished = value;
        }

        public JobInfo? Final { get; set; }

        public JobInfo Snapshot() => Final ?? ToInfo(Row, Log.Count);
    }
}

/// <summary>A signal readers wait on: each <see cref="Fire"/> wakes everyone waiting on <see cref="Next"/>.</summary>
internal sealed class Pulse
{
    private TaskCompletionSource _next = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public Task Next => Volatile.Read(ref _next).Task;

    public void Fire() =>
        Interlocked.Exchange(ref _next, new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously)).TrySetResult();
}
