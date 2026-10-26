using System.Globalization;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Runova.ServerCore.Audit;
using Runova.ServerCore.Backups;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Hubs;

/// <summary>
/// Backups (E15). Owners only, and making one needs a step-up since the file holds every secret the
/// core keeps (sealed, with the keys beside them). The passphrase goes straight to the encryption
/// and never into the audit trail, a log or an answer.
/// </summary>
internal sealed partial class CoreHub
{
    [Authorize(Policy = CorePolicies.Owner)]
    [Authorize(Policy = CorePolicies.StepUp)]
    public async Task<BackupInfo> CreateBackup(BackupRequest request)
    {
        try
        {
            var backup = await security.Backups.CreateAsync(request?.Passphrase ?? string.Empty, Context.ConnectionAborted);
            await AuditAsync("backup.create", AuditResult.Success, backup.Id.ToString("D"), new()
            {
                ["sizeBytes"] = backup.SizeBytes.ToString(CultureInfo.InvariantCulture),
                ["sha256"] = backup.Sha256,
            });
            return backup;
        }
        catch (Exception error) when (error is BackupRefusedException or IOException or UnauthorizedAccessException)
        {
            await AuditAsync("backup.create", AuditResult.Failed, null, new() { ["reason"] = error.Message });
            throw new HubException(error is BackupRefusedException ? error.Message : $"The backup could not be made: {error.Message}");
        }
    }

    [Authorize(Policy = CorePolicies.Owner)]
    public async Task<bool> DeleteBackup(Guid backupId)
    {
        var deleted = security.Backups.Delete(backupId);
        await AuditAsync("backup.delete", deleted ? AuditResult.Success : AuditResult.Failed, backupId.ToString("D"));
        return deleted;
    }
}
