using Microsoft.EntityFrameworkCore;
using Runova.Website.Data;
using Runova.Website.Data.Identity;

namespace Runova.Website.Api.Users;

/// <summary>
/// Deletes invitation links past their expiry. The invited user stays, so an Admin can invite
/// them again. Password reset links are left alone.
/// </summary>
internal sealed partial class InvitationsCleanupJob(AppDbContext db, TimeProvider time, ILogger<InvitationsCleanupJob> logger)
{
    public async Task RunAsync(CancellationToken cancellationToken)
    {
        var now = time.GetUtcNow();
        var deleted = await db.SetupLinks
            .Where(l => l.Purpose == SetupLinkPurposes.Invitation && l.ExpiresAt <= now)
            .ExecuteDeleteAsync(cancellationToken);
        LogDeleted(logger, deleted);
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Deleted {Count} expired invitations")]
    private static partial void LogDeleted(ILogger logger, int count);
}
