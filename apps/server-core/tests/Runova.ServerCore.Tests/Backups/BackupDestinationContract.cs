using System.Security.Cryptography;
using Runova.ServerCore.Backups;
using Runova.ServerCore.Backups.Destinations;

namespace Runova.ServerCore.Tests.Backups;

/// <summary>
/// What every backup destination does (E28), run against each kind: a folder here, FTP and SFTP in
/// the system tests, the cloud drives and Telegram against fakes of their APIs. Each run uses names
/// of its own, so a shared server can hold several runs at once.
/// </summary>
public abstract class BackupDestinationContract : IAsyncLifetime
{
    private readonly string _scratch = Directory.CreateTempSubdirectory("am-dest-").FullName;
    private readonly string _server = "contract-" + Guid.NewGuid().ToString("N")[..8];
    private IBackupDestination? _destination;

    protected static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private protected IBackupDestination Destination => _destination ?? throw new InvalidOperationException("Not started.");

    /// <summary>A destination writing somewhere empty (or empty of this run's names).</summary>
    private protected abstract Task<IBackupDestination> CreateAsync();

    /// <summary>Puts a file that is not a Runova backup where the destination keeps its backups.</summary>
    private protected abstract Task PutForeignFileAsync(string name, byte[] contents);

    public virtual async ValueTask InitializeAsync() => _destination = await CreateAsync();

    public virtual async ValueTask DisposeAsync()
    {
        if (_destination is not null)
        {
            foreach (var manifest in await _destination.ListAsync(CancellationToken.None))
            {
                if (manifest.ServerName == _server)
                {
                    await _destination.DeleteAsync(manifest, CancellationToken.None);
                }
            }

            await _destination.DisposeAsync();
        }

        try
        {
            Directory.Delete(_scratch, recursive: true);
        }
        catch (IOException)
        {
        }

        GC.SuppressFinalize(this);
    }

    private async Task<(BackupUpload Upload, byte[] Bytes)> BackupAsync(int size, long? partBytes, Guid? plan = null, long createdAt = 1_760_000_000_000)
    {
        var bytes = RandomNumberGenerator.GetBytes(size);
        var id = Guid.NewGuid();
        var path = Path.Combine(_scratch, id.ToString("N"));
        await File.WriteAllBytesAsync(path, bytes, Cancel);
        var baseName = BackupNaming.BaseName(_server, createdAt, id);
        var parts = await BackupParts.DescribeAsync(path, partBytes, baseName, Cancel);
        var manifest = new BackupManifestFile(
            BackupManifestFile.SchemaVersion,
            id,
            plan,
            _server,
            createdAt,
            size,
            Convert.ToHexStringLower(SHA256.HashData(bytes)),
            "1.0.0",
            "0123456789abcdef",
            parts);
        return (new BackupUpload(manifest, path, partBytes), bytes);
    }

    private async Task<List<BackupManifestFile>> MineAsync() =>
        [.. (await Destination.ListAsync(Cancel)).Where(manifest => manifest.ServerName == _server)];

    private async Task<byte[]> JoinAsync(BackupManifestFile manifest)
    {
        var output = new MemoryStream();
        await BackupParts.JoinAsync(manifest.Parts, (part, token) => Destination.OpenPartAsync(manifest, part, token), output, Cancel);
        return output.ToArray();
    }

    [Fact]
    public async Task A_test_file_goes_there_and_comes_back() => Assert.Null(await Destination.TestAsync(Cancel));

    [Fact]
    public async Task An_upload_is_listed_and_reads_back_byte_for_byte()
    {
        var plan = Guid.NewGuid();
        var (upload, bytes) = await BackupAsync(70_000, null, plan);

        await Destination.UploadAsync(upload, Cancel);

        var listed = Assert.Single(await MineAsync());
        Assert.Equal(upload.Manifest.BackupId, listed.BackupId);
        Assert.Equal(plan, listed.PlanId);
        Assert.Equal(bytes, await JoinAsync(listed));
    }

    [Fact]
    public async Task A_backup_in_parts_lands_as_parts_and_joins_back()
    {
        var (upload, bytes) = await BackupAsync(50_000, 16_384);

        await Destination.UploadAsync(upload, Cancel);

        var listed = Assert.Single(await MineAsync());
        Assert.Equal(4, listed.Parts.Count);
        Assert.Equal(bytes, await JoinAsync(listed));
    }

    [Fact]
    public async Task Deleting_a_backup_takes_all_of_it_and_leaves_the_others()
    {
        var (first, _) = await BackupAsync(20_000, 8_192, createdAt: 1_760_000_000_000);
        var (second, secondBytes) = await BackupAsync(1_000, null, createdAt: 1_760_000_100_000);
        await Destination.UploadAsync(first, Cancel);
        await Destination.UploadAsync(second, Cancel);

        await Destination.DeleteAsync(first.Manifest, Cancel);

        var left = Assert.Single(await MineAsync());
        Assert.Equal(second.Manifest.BackupId, left.BackupId);
        Assert.Equal(secondBytes, await JoinAsync(left));
    }

    [Fact]
    public async Task Files_that_are_not_backups_are_not_listed()
    {
        await PutForeignFileAsync("holiday-photos.zip", [1, 2, 3]);
        await PutForeignFileAsync($"runova-{_server}-broken.manifest.json", "{ not json"u8.ToArray());

        Assert.Empty(await MineAsync());
    }
}
