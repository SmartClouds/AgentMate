using System.Collections.Concurrent;
using System.Text;
using Runova.ServerCore.Backups;
using Runova.ServerCore.Backups.Destinations;

namespace Runova.ServerCore.Tests.Backups;

/// <summary>
/// Destinations in memory, one store per destination id, for hub and runner tests. A store can be
/// told to refuse uploads, to see one destination fail while the others go on.
/// </summary>
internal sealed class FakeDestinations : IBackupDestinationFactory
{
    private readonly ConcurrentDictionary<Guid, InMemoryBackupDestination> _stores = new();

    public List<ResolvedDestination> Opened { get; } = [];

    public InMemoryBackupDestination this[Guid id] => _stores.GetOrAdd(id, _ => new InMemoryBackupDestination());

    public Task<IBackupDestination> OpenAsync(ResolvedDestination destination, CancellationToken cancellationToken)
    {
        lock (Opened)
        {
            Opened.Add(destination);
        }

        return Task.FromResult<IBackupDestination>(this[destination.Id]);
    }
}

/// <summary>One destination's files in memory. Disposing it keeps them, as a real server would.</summary>
internal sealed class InMemoryBackupDestination : IBackupDestination
{
    private readonly ConcurrentDictionary<string, byte[]> _files = new(StringComparer.Ordinal);

    public string? RefuseWith { get; set; }

    public int Uploads { get; private set; }

    public IReadOnlyCollection<string> Names => [.. _files.Keys.Order(StringComparer.Ordinal)];

    public void Put(string name, byte[] contents) => _files[name] = contents;

    public Task<string?> TestAsync(CancellationToken cancellationToken) => Task.FromResult(RefuseWith);

    public async Task UploadAsync(BackupUpload upload, CancellationToken cancellationToken)
    {
        if (RefuseWith is not null)
        {
            throw new BackupDestinationException(RefuseWith);
        }

        foreach (var part in upload.Manifest.Parts)
        {
            await using var input = BackupParts.OpenPart(upload.FilePath, part, upload.PartBytes);
            var bytes = new MemoryStream();
            await input.CopyToAsync(bytes, cancellationToken);
            upload.Progress?.Report(bytes.Length);
            _files[part.Name] = bytes.ToArray();
        }

        _files[FolderDestination.ManifestNameOf(upload.Manifest)] = Encoding.UTF8.GetBytes(upload.Manifest.ToJson());
        Uploads++;
    }

    public Task<IReadOnlyList<BackupManifestFile>> ListAsync(CancellationToken cancellationToken)
    {
        var manifests = new List<BackupManifestFile>();
        foreach (var (name, bytes) in _files)
        {
            if (!BackupNaming.IsManifestName(name))
            {
                continue;
            }

            try
            {
                manifests.Add(BackupManifestFile.Parse(Encoding.UTF8.GetString(bytes)));
            }
            catch (BackupRefusedException)
            {
            }
        }

        return Task.FromResult<IReadOnlyList<BackupManifestFile>>([.. manifests.OrderByDescending(m => m.CreatedAtUnixMs)]);
    }

    public Task<Stream> OpenPartAsync(BackupManifestFile manifest, BackupPartInfo part, CancellationToken cancellationToken) =>
        _files.TryGetValue(part.Name, out var bytes)
            ? Task.FromResult<Stream>(new MemoryStream(bytes))
            : throw new BackupDestinationException($"{part.Name} is missing.");

    public Task DeleteAsync(BackupManifestFile manifest, CancellationToken cancellationToken)
    {
        _files.TryRemove(FolderDestination.ManifestNameOf(manifest), out _);
        foreach (var part in manifest.Parts)
        {
            _files.TryRemove(part.Name, out _);
        }

        return Task.CompletedTask;
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;
}

/// <summary>The fake keeps the same contract as the real destinations, so tests built on it mean something.</summary>
public sealed class InMemoryDestinationTests : BackupDestinationContract
{
    private readonly InMemoryBackupDestination _store = new();

    private protected override Task<IBackupDestination> CreateAsync() => Task.FromResult<IBackupDestination>(_store);

    private protected override Task PutForeignFileAsync(string name, byte[] contents)
    {
        _store.Put(name, contents);
        return Task.CompletedTask;
    }
}
