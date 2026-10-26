using Runova.ServerCore.Backups.Destinations;
using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.Backups;

/// <summary>What a destination holds, read from its manifests, and taking one backup off it.</summary>
internal sealed class StoredBackups(BackupCenter center, IBackupDestinationFactory factory)
{
    public async Task<StoredBackupInfo[]> ListAsync(Guid destinationId, CancellationToken cancellationToken)
    {
        var destination = await center.OpenDestinationAsync(destinationId, cancellationToken) ?? throw new BackupRefusedException("That destination is gone.");
        await using var opened = await factory.OpenAsync(destination, cancellationToken);
        var manifests = await opened.ListAsync(cancellationToken);
        return [.. manifests
            .OrderByDescending(m => m.CreatedAtUnixMs)
            .Select(m => new StoredBackupInfo(m.BackupId, destinationId, m.PlanId, m.ServerName, m.CreatedAtUnixMs, m.SizeBytes, m.Parts.Count, m.CoreVersion, m.KeyId))];
    }

    public async Task<bool> DeleteAsync(Guid destinationId, Guid backupId, CancellationToken cancellationToken)
    {
        var destination = await center.OpenDestinationAsync(destinationId, cancellationToken) ?? throw new BackupRefusedException("That destination is gone.");
        await using var opened = await factory.OpenAsync(destination, cancellationToken);
        var manifest = (await opened.ListAsync(cancellationToken)).FirstOrDefault(m => m.BackupId == backupId);
        if (manifest is null)
        {
            return false;
        }

        await opened.DeleteAsync(manifest, cancellationToken);
        return true;
    }

    /// <summary>The manifest of one backup on a destination, and the destination opened to read it.</summary>
    public async Task<(IBackupDestination Destination, BackupManifestFile Manifest)> OpenAsync(Guid destinationId, Guid backupId, CancellationToken cancellationToken)
    {
        var destination = await center.OpenDestinationAsync(destinationId, cancellationToken) ?? throw new BackupRefusedException("That destination is gone.");
        var opened = await factory.OpenAsync(destination, cancellationToken);
        var manifest = (await opened.ListAsync(cancellationToken)).FirstOrDefault(m => m.BackupId == backupId);
        if (manifest is null)
        {
            await opened.DisposeAsync();
            throw new BackupRefusedException("That backup is no longer on the destination.");
        }

        return (opened, manifest);
    }
}
