using System.Text;

namespace Runova.ServerCore.Backups.Destinations;

/// <summary>
/// A folder on the server itself (E28), made root-only when missing. Each file is written under a
/// .partial name and moved into place, so a crash leaves no file that looks finished.
/// </summary>
internal sealed class FolderDestination(string root) : IBackupDestination
{
    private const string TestName = ".runova-test";

    public async Task<string?> TestAsync(CancellationToken cancellationToken)
    {
        try
        {
            EnsureRoot();
            var path = Path.Combine(root, TestName);
            var probe = Encoding.UTF8.GetBytes(Guid.NewGuid().ToString("N"));
            await WriteAsync(path, new MemoryStream(probe), null, cancellationToken);
            var back = await File.ReadAllBytesAsync(path, cancellationToken);
            File.Delete(path);
            return back.AsSpan().SequenceEqual(probe) ? null : "A test file came back different.";
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            return $"The folder {root} cannot be written: {error.Message}";
        }
    }

    public async Task UploadAsync(BackupUpload upload, CancellationToken cancellationToken)
    {
        EnsureRoot();
        foreach (var part in upload.Manifest.Parts)
        {
            await using var input = BackupParts.OpenPart(upload.FilePath, part, upload.PartBytes);
            await WriteAsync(Path.Combine(root, part.Name), input, upload.Progress, cancellationToken);
        }

        var manifest = Encoding.UTF8.GetBytes(upload.Manifest.ToJson());
        await WriteAsync(Path.Combine(root, ManifestNameOf(upload.Manifest)), new MemoryStream(manifest), null, cancellationToken);
    }

    public async Task<IReadOnlyList<BackupManifestFile>> ListAsync(CancellationToken cancellationToken)
    {
        if (!Directory.Exists(root))
        {
            return [];
        }

        var manifests = new List<BackupManifestFile>();
        foreach (var path in BackupNaming.Prefixes.SelectMany(prefix => Directory.EnumerateFiles(root, prefix + "*" + BackupNaming.ManifestExtension)))
        {
            if (new FileInfo(path).Length > BackupManifestFile.MaxBytes)
            {
                continue;
            }

            try
            {
                manifests.Add(BackupManifestFile.Parse(await File.ReadAllTextAsync(path, cancellationToken)));
            }
            catch (BackupRefusedException)
            {
                // Not ours, or damaged: a listing shows backups it can restore, nothing else.
            }
        }

        return [.. manifests.OrderByDescending(manifest => manifest.CreatedAtUnixMs)];
    }

    public Task<Stream> OpenPartAsync(BackupManifestFile manifest, BackupPartInfo part, CancellationToken cancellationToken)
    {
        var path = Path.Combine(root, part.Name);
        return File.Exists(path)
            ? Task.FromResult<Stream>(new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 1024 * 1024, useAsync: true))
            : throw new BackupDestinationException($"{part.Name} is missing from {root}.");
    }

    public Task DeleteAsync(BackupManifestFile manifest, CancellationToken cancellationToken)
    {
        File.Delete(Path.Combine(root, ManifestNameOf(manifest)));
        foreach (var part in manifest.Parts)
        {
            File.Delete(Path.Combine(root, part.Name));
        }

        return Task.CompletedTask;
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    /// <summary>The manifest's name follows from its first part: the base name before the extension.</summary>
    internal static string ManifestNameOf(BackupManifestFile manifest)
    {
        var first = manifest.Parts[0].Name;
        var at = BackupNaming.Extensions.Select(extension => first.IndexOf(extension, StringComparison.Ordinal)).FirstOrDefault(index => index > 0, -1);
        return BackupNaming.ManifestName(at > 0 ? first[..at] : first);
    }

    private void EnsureRoot()
    {
        if (OperatingSystem.IsWindows())
        {
            Directory.CreateDirectory(root);
            return;
        }

        Directory.CreateDirectory(root, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
    }

    private static async Task WriteAsync(string path, Stream input, IProgress<long>? progress, CancellationToken cancellationToken)
    {
        var partial = path + ".partial";
        var options = new FileStreamOptions { Mode = FileMode.Create, Access = FileAccess.Write, Share = FileShare.None, Options = FileOptions.Asynchronous };
        if (!OperatingSystem.IsWindows())
        {
            options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        }

        try
        {
            await using (var output = new FileStream(partial, options))
            {
                var buffer = new byte[1024 * 1024];
                int read;
                while ((read = await input.ReadAsync(buffer, cancellationToken)) > 0)
                {
                    await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
                    progress?.Report(read);
                }

                output.Flush(flushToDisk: true);
            }

            File.Move(partial, path, overwrite: true);
        }
        finally
        {
            File.Delete(partial);
        }
    }
}
