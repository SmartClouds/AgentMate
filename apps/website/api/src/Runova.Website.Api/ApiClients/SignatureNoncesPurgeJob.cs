using Microsoft.EntityFrameworkCore;
using Runova.Website.Core.Signing;
using Runova.Website.Data;

namespace Runova.Website.Api.ApiClients;

/// <summary>
/// Deletes the nonces too old to matter: a request that old is refused for its timestamp anyway,
/// so the table only needs the last few minutes to refuse a replay.
/// </summary>
internal sealed partial class SignatureNoncesPurgeJob(AppDbContext db, TimeProvider time, ILogger<SignatureNoncesPurgeJob> logger)
{
    public async Task RunAsync(CancellationToken cancellationToken)
    {
        var cutoff = time.GetUtcNow() - RequestSignature.NonceLifetime;
        var deleted = await db.SignatureNonces.Where(n => n.SeenAt <= cutoff).ExecuteDeleteAsync(cancellationToken);
        LogDeleted(logger, deleted);
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Deleted {Count} old signature nonces")]
    private static partial void LogDeleted(ILogger logger, int count);
}
