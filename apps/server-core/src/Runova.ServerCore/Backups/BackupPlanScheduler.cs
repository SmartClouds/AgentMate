using Cronos;
using Hangfire;
using Hangfire.Storage;
using Runova.ServerCore.Data;

namespace Runova.ServerCore.Backups;

/// <summary>
/// Keeps Hangfire's recurring jobs in step with the backup plans (E28): one job per enabled plan,
/// named <c>backup-plan:&lt;id&gt;</c>, running <see cref="BackupRunner.RunPlanAsync"/> on the plan's
/// cron in its time zone. The plans in core.db are the truth; Hangfire's file only schedules them.
/// </summary>
internal sealed class BackupPlanScheduler(IRecurringJobManager recurring, JobStorage storage)
{
    public const string Prefix = "backup-plan:";

    /// <summary>A backup reads every volume, so a plan runs at most this often.</summary>
    public static readonly TimeSpan MinInterval = TimeSpan.FromMinutes(15);

    public static string RecurringId(Guid planId) => Prefix + planId.ToString("D");

    public void Apply(BackupPlanRecord plan)
    {
        ArgumentNullException.ThrowIfNull(plan);
        if (!plan.Enabled || ScheduleProblem(plan.Cron, plan.TimeZone) is not null)
        {
            recurring.RemoveIfExists(RecurringId(plan.Id));
            return;
        }

        var planId = plan.Id;
        recurring.AddOrUpdate<BackupRunner>(
            RecurringId(planId),
            runner => runner.RunPlanAsync(planId, CancellationToken.None),
            plan.Cron,
            new RecurringJobOptions { TimeZone = Zone(plan.TimeZone)! });
    }

    public void Remove(Guid planId) => recurring.RemoveIfExists(RecurringId(planId));

    /// <summary>Applies every plan and drops the plan jobs no enabled plan owns. Other recurring jobs stay.</summary>
    public void Reconcile(IEnumerable<BackupPlanRecord> plans)
    {
        var wanted = new HashSet<string>(StringComparer.Ordinal);
        foreach (var plan in plans)
        {
            Apply(plan);
            if (plan.Enabled && ScheduleProblem(plan.Cron, plan.TimeZone) is null)
            {
                wanted.Add(RecurringId(plan.Id));
            }
        }

        using var connection = storage.GetConnection();
        foreach (var job in connection.GetRecurringJobs())
        {
            if (job.Id.StartsWith(Prefix, StringComparison.Ordinal) && !wanted.Contains(job.Id))
            {
                recurring.RemoveIfExists(job.Id);
            }
        }
    }

    /// <summary>Why a schedule will not do, or null: it has to parse, name a known zone and run at most every 15 minutes.</summary>
    public static string? ScheduleProblem(string? cron, string? timeZone)
    {
        if (!TryParse(cron, out var expression))
        {
            return "The schedule is not a cron expression (minute hour day month weekday).";
        }

        if (Zone(timeZone) is not { } zone)
        {
            return $"'{timeZone}' is not a time zone this server knows. Servers without the tzdata package know only UTC: install it, or pick UTC.";
        }

        var runs = Occurrences(expression, zone, DateTimeOffset.UtcNow, 4);
        if (runs.Count == 0)
        {
            return "The schedule never runs.";
        }

        for (var i = 1; i < runs.Count; i++)
        {
            if (runs[i] - runs[i - 1] < MinInterval)
            {
                return "A plan can run at most every 15 minutes.";
            }
        }

        return null;
    }

    /// <summary>The next runs after <paramref name="from"/>, as unix milliseconds. Empty for a schedule that will not do.</summary>
    public static IReadOnlyList<long> NextRuns(string cron, string timeZone, DateTimeOffset from, int count)
    {
        if (!TryParse(cron, out var expression) || Zone(timeZone) is not { } zone)
        {
            return [];
        }

        return [.. Occurrences(expression, zone, from, count).Select(run => run.ToUnixTimeMilliseconds())];
    }

    private static List<DateTimeOffset> Occurrences(CronExpression expression, TimeZoneInfo zone, DateTimeOffset from, int count)
    {
        var runs = new List<DateTimeOffset>(count);
        var at = from;
        while (runs.Count < count && expression.GetNextOccurrence(at, zone) is { } next)
        {
            runs.Add(next);
            at = next;
        }

        return runs;
    }

    private static bool TryParse(string? cron, out CronExpression expression)
    {
        expression = null!;
        if (string.IsNullOrWhiteSpace(cron) || cron.Length > 100)
        {
            return false;
        }

        try
        {
            expression = CronExpression.Parse(cron.Trim(), CronFormat.Standard);
            return true;
        }
        catch (CronFormatException)
        {
            return false;
        }
    }

    private static TimeZoneInfo? Zone(string? timeZone) =>
        !string.IsNullOrWhiteSpace(timeZone) && TimeZoneInfo.TryFindSystemTimeZoneById(timeZone, out var zone) ? zone : null;
}
