using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Runova.ServerCore.Data;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Audit;

internal static class AuditResult
{
    public const string Success = "success";
    public const string Denied = "denied";
    public const string Failed = "failed";
    public const string Cancelled = "cancelled";

    public static readonly string[] All = [Success, Denied, Failed, Cancelled];
}

/// <summary>What happened, by whom, to what. Parameters are redacted before they are stored.</summary>
internal sealed record AuditEntry(
    string Action,
    string Result,
    Guid? ActorUserId = null,
    Guid? DeviceId = null,
    int? PeerUid = null,
    string? Target = null,
    IReadOnlyDictionary<string, string?>? Parameters = null);

/// <summary>Whether every stored event still hashes to what the next one recorded.</summary>
internal sealed record AuditVerification(bool Intact, int Checked, long? BrokenAt);

/// <summary>
/// The append-only, hash-chained audit trail. Each event's hash covers its own fields and the
/// previous event's hash, so an edit, a deletion or a reordering breaks verification from that
/// point on. Appends read the previous hash inside a write transaction (BEGIN IMMEDIATE), so the
/// service and an admin command appending at the same time still build one chain.
/// </summary>
/// <remarks>
/// Someone with write access to the database file can rebuild the whole chain; the chain shows
/// tampering by anything short of that, which the file's root-only permissions guard.
/// </remarks>
internal sealed class AuditLog(IDbContextFactory<CoreDbContext> contexts, TimeProvider time, Redactor redactor)
    : IDisposable
{
    public const string Genesis = "0000000000000000000000000000000000000000000000000000000000000000";

    private readonly SemaphoreSlim _gate = new(1, 1);

    public async Task<AuditEvent> AppendAsync(AuditEntry entry, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(entry);
        await _gate.WaitAsync(cancellationToken);
        try
        {
            await using var db = await contexts.CreateDbContextAsync(cancellationToken);
            await using var transaction = await BeginWriteAsync(db, cancellationToken);

            var last = await db.AuditEvents
                .OrderByDescending(e => e.Id)
                .Select(e => new { e.Id, e.Hash })
                .FirstOrDefaultAsync(cancellationToken);
            var anchor = last is null
                ? await db.AuditAnchors.AsNoTracking().FirstOrDefaultAsync(cancellationToken)
                : null;

            var stored = new AuditEvent
            {
                Id = (last?.Id ?? anchor?.LastPrunedId ?? 0) + 1,
                At = time.GetUtcNow().ToUnixTimeMilliseconds(),
                ActorUserId = entry.ActorUserId,
                DeviceId = entry.DeviceId,
                PeerUid = entry.PeerUid,
                Action = entry.Action,
                Target = entry.Target,
                Parameters = redactor.Serialize(entry.Parameters),
                Result = entry.Result,
                PrevHash = last?.Hash ?? anchor?.LastPrunedHash ?? Genesis,
                Hash = string.Empty,
            };
            stored.Hash = HashOf(stored);
            db.AuditEvents.Add(stored);
            await db.SaveChangesAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return stored;
        }
        finally
        {
            _gate.Release();
        }
    }

    public void Dispose() => _gate.Dispose();

    public async Task<AuditVerification> VerifyAsync(CancellationToken cancellationToken = default)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var anchor = await db.AuditAnchors.AsNoTracking().FirstOrDefaultAsync(cancellationToken);
        var expectedId = (anchor?.LastPrunedId ?? 0) + 1;
        var previous = anchor?.LastPrunedHash ?? Genesis;
        var checkedCount = 0;

        await foreach (var stored in db.AuditEvents.AsNoTracking().OrderBy(e => e.Id).AsAsyncEnumerable()
            .WithCancellation(cancellationToken))
        {
            if (stored.Id != expectedId || stored.PrevHash != previous || stored.Hash != HashOf(stored))
            {
                return new AuditVerification(false, checkedCount, stored.Id);
            }

            previous = stored.Hash;
            expectedId++;
            checkedCount++;
        }

        return new AuditVerification(true, checkedCount, null);
    }

    /// <summary>
    /// Removes events older than <paramref name="cutoff"/> (always a run from the start of the
    /// chain) and records where the chain continues, so what is left still verifies.
    /// </summary>
    public async Task<int> PruneAsync(DateTimeOffset cutoff, CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            await using var db = await contexts.CreateDbContextAsync(cancellationToken);
            await using var transaction = await BeginWriteAsync(db, cancellationToken);

            var cutoffMs = cutoff.ToUnixTimeMilliseconds();
            var last = await db.AuditEvents
                .Where(e => e.At < cutoffMs)
                .OrderByDescending(e => e.Id)
                .Select(e => new { e.Id, e.Hash })
                .FirstOrDefaultAsync(cancellationToken);
            if (last is null)
            {
                return 0;
            }

            var anchor = await db.AuditAnchors.FirstOrDefaultAsync(cancellationToken);
            if (anchor is null)
            {
                db.AuditAnchors.Add(new AuditAnchor { Id = 1, LastPrunedId = last.Id, LastPrunedHash = last.Hash });
            }
            else
            {
                anchor.LastPrunedId = last.Id;
                anchor.LastPrunedHash = last.Hash;
            }

            await db.SaveChangesAsync(cancellationToken);
            var removed = await db.AuditEvents.Where(e => e.Id <= last.Id).ExecuteDeleteAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return removed;
        }
        finally
        {
            _gate.Release();
        }
    }

    private static async Task<Microsoft.EntityFrameworkCore.Storage.IDbContextTransaction> BeginWriteAsync(
        CoreDbContext db,
        CancellationToken cancellationToken)
    {
        var connection = (SqliteConnection)db.Database.GetDbConnection();
        await connection.OpenAsync(cancellationToken);
        return await db.Database.UseTransactionAsync(CoreDatabase.BeginWrite(connection), cancellationToken)
            ?? throw new InvalidOperationException("The audit trail could not start a write transaction.");
    }

    /// <summary>SHA-256 over the event's fields as a JSON array, so no two field values can run together.</summary>
    internal static string HashOf(AuditEvent stored)
    {
        var fields = new[]
        {
            stored.PrevHash,
            stored.Id.ToString(CultureInfo.InvariantCulture),
            stored.At.ToString(CultureInfo.InvariantCulture),
            stored.ActorUserId?.ToString("D"),
            stored.DeviceId?.ToString("D"),
            stored.PeerUid?.ToString(CultureInfo.InvariantCulture),
            stored.Action,
            stored.Target,
            stored.Parameters,
            stored.Result,
        };
        var canonical = JsonSerializer.SerializeToUtf8Bytes(fields);
        return Convert.ToHexStringLower(SHA256.HashData(canonical));
    }
}
