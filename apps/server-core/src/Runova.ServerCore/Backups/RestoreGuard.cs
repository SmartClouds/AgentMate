using Microsoft.EntityFrameworkCore;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Firewall;
using Runova.ServerCore.Hardening;

namespace Runova.ServerCore.Backups;

/// <summary>
/// A restore swaps the whole state folder. A firewall or SSH change still waiting to be kept keeps
/// what its rollback timer needs (the snapshot and the decision file) in that folder, so after a
/// swap the timer would find nothing to put back and the change would stay, possibly one that cuts
/// SSH off. Until every such change is decided, the restore waits. So does a server backup being
/// made (E28): the swap stops the core, which would end it half written.
/// </summary>
internal static class RestoreGuard
{
    private static readonly FirewallChangeState[] _settled =
    [
        FirewallChangeState.Confirmed,
        FirewallChangeState.RolledBack,
        FirewallChangeState.RollbackFailed,
        FirewallChangeState.Failed,
    ];

    /// <summary>Each change still waiting, in words; empty when a restore may go ahead.</summary>
    public static async Task<IReadOnlyList<string>> PendingAsync(string dataDirectory, CoreDbContext db, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(db);
        var pending = new List<string>();
        foreach (var files in SshChangeFiles.All(dataDirectory))
        {
            if (files.Decision() is null && files.ReadSnapshot() is { } snapshot)
            {
                pending.Add($"SSH change \"{snapshot.Summary}\" ({snapshot.Id:D})");
            }
        }

        var root = FirewallChangeFiles.Root(dataDirectory);
        if (Directory.Exists(root))
        {
            foreach (var folder in Directory.EnumerateDirectories(root))
            {
                if (!Guid.TryParseExact(Path.GetFileName(folder), "N", out var id))
                {
                    continue;
                }

                var files = new FirewallChangeFiles(dataDirectory, id);
                if (files.Decision() is not null || files.ReadSnapshot() is null)
                {
                    continue;
                }

                // A change whose timer never armed was never applied: nothing to roll back.
                var row = await db.FirewallChangeSets.AsNoTracking()
                    .Where(change => change.Id == id)
                    .Select(change => new { change.State, change.Summary })
                    .FirstOrDefaultAsync(cancellationToken);
                if (row is null || !_settled.Contains(row.State))
                {
                    pending.Add($"firewall change \"{row?.Summary ?? "unknown"}\" ({id:D})");
                }
            }
        }

        var running = await db.BackupRuns.AsNoTracking()
            .Where(run => run.State == BackupRunState.Running)
            .Select(run => run.PlanName ?? "made by hand")
            .ToListAsync(cancellationToken);
        pending.AddRange(running.Select(name => $"backup \"{name}\" being made"));
        return pending;
    }

    public static string Refusal(IReadOnlyList<string> pending)
    {
        ArgumentNullException.ThrowIfNull(pending);
        return $"This server has {(pending.Count == 1 ? "a change" : "changes")} waiting to be kept or reverted: {string.Join("; ", pending)}. "
            + "Keep or revert it on this server first, then restore. A restore would take away what its rollback needs, so the change could stay in place.";
    }
}
