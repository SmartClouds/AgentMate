using Runova.ServerCore.Backups;

namespace Runova.ServerCore.Tests.Backups;

/// <summary>
/// Which backups a plan deletes from a destination after an upload, and what the plan screen
/// promises about it. Only the plan's own backups are ever touched, and nothing is pruned unless the
/// backup just uploaded is there.
/// </summary>
public sealed class RetentionPlannerTests
{
    private static readonly Guid _plan = Guid.Parse("aaaaaaaa-0000-0000-0000-000000000001");
    private static readonly Guid _otherPlan = Guid.Parse("aaaaaaaa-0000-0000-0000-000000000002");
    private const long Day = 86_400_000;
    private const long Now = 100 * Day;

    private static StoredBackup Backup(int daysAgo, Guid? plan = null) =>
        new(Guid.NewGuid(), plan ?? _plan, Now - (daysAgo * Day));

    [Fact]
    public void The_newest_backups_are_kept_and_the_rest_go()
    {
        var stored = Enumerable.Range(0, 6).Select(days => Backup(days)).ToList();

        var deleted = RetentionPlanner.ToDelete(stored, _plan, new RetentionRule(3, null), stored[0].BackupId, Now);

        Assert.Equal(stored.Skip(3).Select(backup => backup.BackupId).Order(), deleted.Order());
    }

    [Fact]
    public void Another_plan_s_backups_and_manual_ones_are_never_touched()
    {
        var mine = Enumerable.Range(0, 3).Select(days => Backup(days)).ToList();
        var others = new[] { Backup(10, _otherPlan), Backup(20, _otherPlan), new StoredBackup(Guid.NewGuid(), null, Now - (30 * Day)) };

        var deleted = RetentionPlanner.ToDelete([.. mine, .. others], _plan, new RetentionRule(1, null), mine[0].BackupId, Now);

        Assert.Equal(2, deleted.Count);
        Assert.DoesNotContain(deleted, id => others.Any(other => other.BackupId == id));
    }

    [Fact]
    public void Nothing_is_pruned_when_the_upload_is_not_there()
    {
        var stored = Enumerable.Range(0, 5).Select(days => Backup(days + 1)).ToList();

        var deleted = RetentionPlanner.ToDelete(stored, _plan, new RetentionRule(1, null), Guid.NewGuid(), Now);

        Assert.Empty(deleted);
    }

    [Fact]
    public void Backups_past_the_day_limit_go_even_under_the_count_but_the_newest_stays()
    {
        var stored = new[] { Backup(0), Backup(5), Backup(9), Backup(12) };

        var deleted = RetentionPlanner.ToDelete(stored, _plan, new RetentionRule(10, 7), stored[0].BackupId, Now);

        Assert.Equal(new[] { stored[2].BackupId, stored[3].BackupId }.Order(), deleted.Order());
        var onlyOld = new[] { Backup(30) };
        Assert.Empty(RetentionPlanner.ToDelete(onlyOld, _plan, new RetentionRule(10, 7), onlyOld[0].BackupId, Now));
    }

    [Theory]
    [InlineData(0, null)]
    [InlineData(1001, null)]
    [InlineData(3, 0)]
    [InlineData(3, 3651)]
    public void A_rule_out_of_range_is_refused(int keepLast, int? keepDays) =>
        Assert.NotNull(new RetentionRule(keepLast, keepDays).Problem());

    [Fact]
    public void The_preview_counts_what_stays_and_when_the_first_one_goes()
    {
        var daily = Enumerable.Range(1, 40).Select(day => Now + (day * Day)).ToList();

        var preview = RetentionPlanner.Preview(daily, new RetentionRule(7, null), lastSizeBytes: 2_000, existing: 4);

        Assert.Equal(7, preview.Kept);
        Assert.Equal(14_000, preview.BytesPerDestination);
        Assert.Equal(daily[3], preview.FirstDeletionAtUnixMs);
        Assert.Equal(6 * Day, preview.CoversMs);
    }

    [Fact]
    public void The_preview_with_a_day_limit_keeps_what_fits_in_those_days()
    {
        var everySixHours = Enumerable.Range(1, 200).Select(run => Now + (run * Day / 4)).ToList();

        var preview = RetentionPlanner.Preview(everySixHours, new RetentionRule(100, 2), lastSizeBytes: null, existing: 0);

        Assert.Equal(8, preview.Kept);
        Assert.Null(preview.BytesPerDestination);
        Assert.Equal(everySixHours[8], preview.FirstDeletionAtUnixMs);
    }

    [Fact]
    public void A_plan_already_over_its_count_deletes_at_the_next_run()
    {
        var runs = new[] { Now + Day, Now + (2 * Day) };

        var preview = RetentionPlanner.Preview(runs, new RetentionRule(2, null), 10, existing: 5);

        Assert.Equal(runs[0], preview.FirstDeletionAtUnixMs);
    }
}
