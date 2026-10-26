using Microsoft.EntityFrameworkCore;
using Runova.ServerCore.Backups;
using Runova.ServerCore.Cli;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Hosting;

namespace Runova.ServerCore.Updates;

/// <summary>
/// The core's side of a layout migration: whether one may start, and starting it. The migration
/// itself stops this core, so it runs a few seconds later from a transient unit of its own
/// (`migrate-layout`, from the release this core runs), after the app has heard the answer. It
/// shares the core update's gate: an update and a migration never overlap.
/// </summary>
internal sealed class LayoutMigrator(
    ICoreInstallation installation,
    CoreUpdater updater,
    SystemdRunner units,
    LayoutMigrationJournalFile journal,
    CoreDirectories directories,
    IDbContextFactory<CoreDbContext> contexts)
{
    /// <summary>Between the answer and the migration's start.</summary>
    public static readonly TimeSpan StartDelay = TimeSpan.FromSeconds(3);

    public LayoutMigrationStatus Status() => journal.Status(installation.Layout);

    public async Task<LayoutMigrationResult> StartAsync(CancellationToken cancellationToken)
    {
        if (installation.Layout.Kind == CoreLayoutKind.Runova)
        {
            return new LayoutMigrationResult(LayoutMigrationOutcome.AlreadyMigrated);
        }

        if (installation.CurrentRelease is not { } release)
        {
            return Refused("This core was not installed by the app, so it cannot move itself.");
        }

        var program = Path.Combine(release, CoreLayout.Runova.Binary);
        if (!File.Exists(program) || !File.Exists(Path.Combine(release, CoreLayout.Runova.UnitFile)))
        {
            return Refused("This release cannot move the server yet. Update the server core first.");
        }

        if (journal.Read()?.Phase == LayoutMigrationPhase.Running)
        {
            return Refused("A migration is already under way.");
        }

        await using (var db = await contexts.CreateDbContextAsync(cancellationToken))
        {
            var pending = await RestoreGuard.PendingAsync(directories.Data, db, cancellationToken);
            if (pending.Count > 0)
            {
                return Refused($"Confirm or undo these first: {string.Join("; ", pending)}.");
            }
        }

        try
        {
            await updater.ScheduleExclusiveAsync(async () =>
            {
                var unit = SystemdRunner.UnitName("migrate", Guid.NewGuid());
                await units.ScheduleAsync(
                    unit,
                    "Move the server core to the Runova layout",
                    new ProcessSpec
                    {
                        Program = program,
                        Arguments = [MigrateLayoutCommand.Name],
                        Environment = new Dictionary<string, string>(StringComparer.Ordinal) { [MigrateLayoutCommand.UnitVariable] = unit },
                    },
                    StartDelay,
                    cancellationToken);
            });
        }
        catch (CoreUpdateException error)
        {
            return Refused(error.Message);
        }
        catch (ProcessFailedException error)
        {
            return Refused(error.Message);
        }

        return new LayoutMigrationResult(LayoutMigrationOutcome.Started);
    }

    private static LayoutMigrationResult Refused(string problem) => new(LayoutMigrationOutcome.Refused, problem);
}
