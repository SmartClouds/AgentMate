namespace Runova.ServerCore.Backups;

/// <summary>How many of a plan's backups each destination keeps: the newest N, and optionally none older than D days.</summary>
internal sealed record RetentionRule(int KeepLast, int? KeepDays)
{
    public const int MaxKeepLast = 1000;
    public const int MaxKeepDays = 3650;

    public string? Problem() => this switch
    {
        { KeepLast: < 1 or > MaxKeepLast } => $"Keep between 1 and {MaxKeepLast} backups.",
        { KeepDays: < 1 or > MaxKeepDays } => $"Keep backups between 1 and {MaxKeepDays} days.",
        _ => null,
    };
}

/// <summary>A backup a destination holds, as its manifest names it.</summary>
internal sealed record StoredBackup(Guid BackupId, Guid? PlanId, long CreatedAtUnixMs);

/// <summary>What the plan screen promises: how many stay, about how much room they take, and when the first goes.</summary>
internal sealed record RetentionPreview(int Kept, long? BytesPerDestination, long? FirstDeletionAtUnixMs, long CoversMs);

internal static class RetentionPlanner
{
    private const long DayMs = 86_400_000;

    /// <summary>
    /// The plan's backups to delete from one destination once <paramref name="justUploaded"/> is
    /// on it. Backups other plans made, or made by hand, are never in the answer, nor is the newest.
    /// When the upload is not in the listing nothing is deleted: a run that failed never prunes.
    /// </summary>
    public static IReadOnlyList<Guid> ToDelete(IEnumerable<StoredBackup> stored, Guid planId, RetentionRule rule, Guid justUploaded, long nowUnixMs)
    {
        var mine = stored.Where(backup => backup.PlanId == planId).OrderByDescending(backup => backup.CreatedAtUnixMs).ToList();
        if (!mine.Any(backup => backup.BackupId == justUploaded))
        {
            return [];
        }

        var deleted = new List<Guid>();
        for (var i = 1; i < mine.Count; i++)
        {
            var tooMany = i >= rule.KeepLast;
            var tooOld = rule.KeepDays is { } days && nowUnixMs - mine[i].CreatedAtUnixMs >= days * DayMs;
            if (tooMany || tooOld)
            {
                deleted.Add(mine[i].BackupId);
            }
        }

        return deleted;
    }

    /// <summary>
    /// The steady state of a plan from its next run times (oldest first, enough to cover the rule),
    /// the size of its last backup and how many of its backups a destination holds now.
    /// </summary>
    public static RetentionPreview Preview(IReadOnlyList<long> upcomingRuns, RetentionRule rule, long? lastSizeBytes, int existing)
    {
        if (upcomingRuns.Count == 0)
        {
            return new RetentionPreview(Math.Min(rule.KeepLast, existing), lastSizeBytes * Math.Min(rule.KeepLast, existing), null, 0);
        }

        var kept = rule.KeepLast;
        if (rule.KeepDays is { } days)
        {
            var window = upcomingRuns.Count(run => run - upcomingRuns[0] < days * DayMs);
            kept = Math.Max(1, Math.Min(kept, window));
        }

        var firstDeletion = Math.Max(0, kept - existing);
        return new RetentionPreview(
            kept,
            lastSizeBytes * kept,
            firstDeletion < upcomingRuns.Count ? upcomingRuns[firstDeletion] : null,
            upcomingRuns[Math.Min(kept, upcomingRuns.Count) - 1] - upcomingRuns[0]);
    }
}
