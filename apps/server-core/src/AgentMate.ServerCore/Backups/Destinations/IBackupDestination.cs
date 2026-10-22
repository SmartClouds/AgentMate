namespace AgentMate.ServerCore.Backups.Destinations;

/// <summary>A backup file on this server, ready to send: the manifest says how it is cut into parts.</summary>
internal sealed record BackupUpload(BackupManifestFile Manifest, string FilePath, long? PartBytes, IProgress<long>? Progress = null);

/// <summary>A destination could not be reached or refused something; the message is worded for the person.</summary>
internal sealed class BackupDestinationException(string message, Exception? inner = null) : Exception(message, inner);

/// <summary>
/// Somewhere backups go (E28). Every kind passes the same contract: an upload lands parts first and
/// the manifest last, so a listing (which reads manifests only) never shows half a backup; a
/// deletion takes the manifest first for the same reason. Names come from <see cref="BackupNaming"/>.
/// </summary>
internal interface IBackupDestination : IAsyncDisposable
{
    /// <summary>Writes, reads back and deletes a small file. Null when that worked, or why not.</summary>
    Task<string?> TestAsync(CancellationToken cancellationToken);

    Task UploadAsync(BackupUpload upload, CancellationToken cancellationToken);

    /// <summary>The backups held, from their manifests. Files that are not AgentMate backups are left alone.</summary>
    Task<IReadOnlyList<BackupManifestFile>> ListAsync(CancellationToken cancellationToken);

    /// <summary>One part's bytes. The caller checks them against the manifest.</summary>
    Task<Stream> OpenPartAsync(BackupManifestFile manifest, BackupPartInfo part, CancellationToken cancellationToken);

    Task DeleteAsync(BackupManifestFile manifest, CancellationToken cancellationToken);
}

/// <summary>Opens a destination from its unsealed settings. Tests put fakes in its place.</summary>
internal interface IBackupDestinationFactory
{
    Task<IBackupDestination> OpenAsync(ResolvedDestination destination, CancellationToken cancellationToken);
}
