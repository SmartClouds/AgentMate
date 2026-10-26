using System.Security.Claims;
using Runova.ServerCore.Audit;
using Runova.ServerCore.Backups;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Endpoints;

/// <summary>
/// A backup goes down over REST, since it can be far larger than a hub message: the encrypted file
/// as the core wrote it, streamed. Owners only, like making one. The app deletes it once it has it.
/// </summary>
internal static class BackupEndpoints
{
    public const string Prefix = "/api/v1/backups";

    public static IEndpointRouteBuilder MapBackupEndpoints(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapGroup(Prefix).RequireAuthorization(CorePolicies.Owner).MapGet("/{backupId:guid}", DownloadAsync);
        return endpoints;
    }

    private static async Task<IResult> DownloadAsync(Guid backupId, HttpContext context, BackupService backups, AuditLog audit)
    {
        var file = backups.OpenRead(backupId);
        var user = context.User;
        await audit.AppendAsync(new AuditEntry(
            "backup.download",
            file is null ? AuditResult.Failed : AuditResult.Success,
            Guid.TryParse(user.FindFirstValue(ClaimTypes.NameIdentifier), out var userId) ? userId : null,
            Guid.TryParse(user.FindFirstValue(CoreAuthentication.DeviceClaim), out var deviceId) ? deviceId : null,
            PeerCredentials.UidOf(context),
            backupId.ToString("D")));
        return file is null
            ? Results.NotFound()
            : Results.Stream(file, "application/octet-stream");
    }
}
