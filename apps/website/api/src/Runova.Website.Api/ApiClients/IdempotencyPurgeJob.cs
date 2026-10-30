using Microsoft.EntityFrameworkCore;
using Runova.Website.Data;

namespace Runova.Website.Api.ApiClients;

/// <summary>Deletes the idempotency records past their 24 hours.</summary>
internal sealed partial class IdempotencyPurgeJob(AppDbContext db, TimeProvider time, ILogger<IdempotencyPurgeJob> logger)
{
    public async Task RunAsync(CancellationToken cancellationToken)
    {
        var cutoff = time.GetUtcNow() - Idempotency.Lifetime;
        var deleted = await db.IdempotencyRecords.Where(r => r.CreatedAt <= cutoff).ExecuteDeleteAsync(cancellationToken);
        LogDeleted(logger, deleted);
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Deleted {Count} expired idempotency records")]
    private static partial void LogDeleted(ILogger logger, int count);
}
