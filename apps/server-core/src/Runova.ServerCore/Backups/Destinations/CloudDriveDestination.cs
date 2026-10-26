using System.Text;

namespace Runova.ServerCore.Backups.Destinations;

/// <summary>A file in a cloud drive's backup folder.</summary>
internal sealed record CloudFile(string Id, string Name, long Size);

/// <summary>One folder in a cloud drive: the few calls a backup destination needs, behind each drive's own API.</summary>
internal interface ICloudFiles : IAsyncDisposable
{
    Task<IReadOnlyList<CloudFile>> ListAsync(CancellationToken cancellationToken);

    /// <summary>Uploads a file, replacing one of the same name.</summary>
    Task PutAsync(string name, Stream content, long length, IProgress<long>? progress, CancellationToken cancellationToken);

    Task<Stream> OpenAsync(CloudFile file, CancellationToken cancellationToken);

    Task DeleteAsync(CloudFile file, CancellationToken cancellationToken);
}

/// <summary>
/// A cloud drive as a backup destination (E28): Google Drive or OneDrive through
/// <see cref="ICloudFiles"/>. Parts go up first and the manifest last; a deletion takes the
/// manifest first. Downloads land in a temporary file that deletes itself.
/// </summary>
internal sealed class CloudDriveDestination(ICloudFiles files, string driveName) : IBackupDestination
{
    private const string TestName = ".runova-test";

    private Dictionary<string, CloudFile> _byName = new(StringComparer.Ordinal);

    public async Task<string?> TestAsync(CancellationToken cancellationToken)
    {
        try
        {
            var probe = Encoding.UTF8.GetBytes(Guid.NewGuid().ToString("N"));
            await PutAsync(TestName, new MemoryStream(probe), probe.Length, null, cancellationToken);
            var file = await FindAsync(TestName, cancellationToken) ?? throw new BackupDestinationException($"{driveName} did not keep a test file.");
            byte[] back;
            await using (var stream = await files.OpenAsync(file, cancellationToken))
            {
                var buffer = new MemoryStream();
                await stream.CopyToAsync(buffer, cancellationToken);
                back = buffer.ToArray();
            }

            await files.DeleteAsync(file, cancellationToken);
            return back.AsSpan().SequenceEqual(probe) ? null : "A test file came back different.";
        }
        catch (BackupDestinationException refused)
        {
            return refused.Message;
        }
    }

    public async Task UploadAsync(BackupUpload upload, CancellationToken cancellationToken)
    {
        foreach (var part in upload.Manifest.Parts)
        {
            await using var input = BackupParts.OpenPart(upload.FilePath, part, upload.PartBytes);
            await PutAsync(part.Name, input, part.SizeBytes, upload.Progress, cancellationToken);
        }

        var manifest = Encoding.UTF8.GetBytes(upload.Manifest.ToJson());
        await PutAsync(FolderDestination.ManifestNameOf(upload.Manifest), new MemoryStream(manifest), manifest.Length, null, cancellationToken);
    }

    public async Task<IReadOnlyList<BackupManifestFile>> ListAsync(CancellationToken cancellationToken)
    {
        var listed = await RefreshAsync(cancellationToken);
        var manifests = new List<BackupManifestFile>();
        foreach (var file in listed.Where(f => BackupNaming.IsManifestName(f.Name) && f.Size <= BackupManifestFile.MaxBytes))
        {
            try
            {
                await using var stream = await files.OpenAsync(file, cancellationToken);
                using var reader = new StreamReader(stream);
                manifests.Add(BackupManifestFile.Parse(await reader.ReadToEndAsync(cancellationToken)));
            }
            catch (BackupRefusedException)
            {
                // Not ours, or damaged.
            }
        }

        return [.. manifests.OrderByDescending(manifest => manifest.CreatedAtUnixMs)];
    }

    public async Task<Stream> OpenPartAsync(BackupManifestFile manifest, BackupPartInfo part, CancellationToken cancellationToken)
    {
        var file = await FindAsync(part.Name, cancellationToken) ?? throw new BackupDestinationException($"{part.Name} is missing from {driveName}.");
        return await files.OpenAsync(file, cancellationToken);
    }

    public async Task DeleteAsync(BackupManifestFile manifest, CancellationToken cancellationToken)
    {
        await RefreshAsync(cancellationToken);
        foreach (var name in manifest.Parts.Select(part => part.Name).Prepend(FolderDestination.ManifestNameOf(manifest)))
        {
            if (_byName.TryGetValue(name, out var file))
            {
                await files.DeleteAsync(file, cancellationToken);
                _byName.Remove(name);
            }
        }
    }

    public ValueTask DisposeAsync() => files.DisposeAsync();

    /// <summary>A put replaces the file, which may give it a new id, so the name is looked up again afterwards.</summary>
    private async Task PutAsync(string name, Stream content, long length, IProgress<long>? progress, CancellationToken cancellationToken)
    {
        _byName.Remove(name);
        await files.PutAsync(name, content, length, progress, cancellationToken);
    }

    private async Task<IReadOnlyList<CloudFile>> RefreshAsync(CancellationToken cancellationToken)
    {
        var listed = await files.ListAsync(cancellationToken);
        _byName = listed.GroupBy(f => f.Name, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
        return listed;
    }

    private async Task<CloudFile?> FindAsync(string name, CancellationToken cancellationToken)
    {
        if (_byName.TryGetValue(name, out var known))
        {
            return known;
        }

        await RefreshAsync(cancellationToken);
        return _byName.GetValueOrDefault(name);
    }
}
