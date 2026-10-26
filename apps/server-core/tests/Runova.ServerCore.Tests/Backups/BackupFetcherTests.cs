using System.Security.Cryptography;
using Hangfire;
using Hangfire.Storage.SQLite;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Time.Testing;
using Runova.ServerCore.Backups;
using Runova.ServerCore.Backups.Destinations;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Hosting;

namespace Runova.ServerCore.Tests.Backups;

/// <summary>
/// A backup fetched from a destination onto this server (E28), for a restore or a download: its
/// parts joined and checked, then kept where both restore-stage and the download read it.
/// </summary>
public sealed class BackupFetcherTests : IAsyncLifetime
{
    private readonly FakeTimeProvider _clock = new();
    private readonly FakeDestinations _destinations = new();
    private TestDatabase _database = null!;
    private SQLiteStorage _hangfire = null!;
    private BackupCenter _center = null!;
    private BackupService _downloads = null!;
    private BackupFetcher _fetcher = null!;

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    public async ValueTask InitializeAsync()
    {
        _database = await TestDatabase.CreateAsync();
        _hangfire = new SQLiteStorage(Path.Combine(_database.Directory, "hangfire.db"), new SQLiteStorageOptions());
        _center = new BackupCenter(_database.Contexts, new EphemeralDataProtectionProvider(), new BackupPlanScheduler(new RecurringJobManager(_hangfire), _hangfire), _clock);
        var directories = new CoreDirectories(_database.Directory);
        _downloads = new BackupService(directories, _clock);
        _fetcher = new BackupFetcher(new StoredBackups(_center, _destinations), _downloads, directories);
    }

    public async ValueTask DisposeAsync()
    {
        _downloads.Dispose();
        _hangfire.Dispose();
        await _database.DisposeAsync();
    }

    private async Task<(Guid Destination, BackupManifestFile Manifest, byte[] Bytes)> StoreAsync(int size, long partBytes)
    {
        var destination = await _center.SaveDestinationAsync(
            new SaveBackupDestinationRequest(null, "offsite", BackupDestinationKind.Folder, new BackupDestinationSettings(Path: "/srv/offsite"), null, partBytes),
            null,
            Cancel);
        var bytes = RandomNumberGenerator.GetBytes(size);
        var file = Path.Combine(_database.Directory, "source.ambackup");
        await File.WriteAllBytesAsync(file, bytes, Cancel);
        var id = Guid.NewGuid();
        var parts = await BackupParts.DescribeAsync(file, partBytes, BackupNaming.BaseName("web-1", 1, id), Cancel);
        var manifest = new BackupManifestFile(BackupManifestFile.SchemaVersion, id, null, "web-1", 1, size, Convert.ToHexStringLower(SHA256.HashData(bytes)), "1", "k", parts);
        await _destinations[destination.Id].UploadAsync(new BackupUpload(manifest, file, partBytes), Cancel);
        return (destination.Id, manifest, bytes);
    }

    [Fact]
    public async Task A_backup_in_parts_lands_whole_where_restore_and_download_read_it()
    {
        var (destination, manifest, bytes) = await StoreAsync(5 * 1024 * 1024 + 7, 2 * 1024 * 1024);
        var started = _fetcher.Begin(manifest.BackupId);

        await _fetcher.RunAsync(started.Id, destination, manifest.BackupId, Cancel);

        var done = _fetcher.Find(started.Id)!;
        Assert.Equal(BackupRunState.Succeeded, done.State);
        Assert.Equal(bytes.Length, done.BytesDone);
        Assert.Equal(bytes, await File.ReadAllBytesAsync(done.Path!, Cancel));
        await using var download = _downloads.OpenRead(manifest.BackupId);
        Assert.NotNull(download);
    }

    [Fact]
    public async Task A_changed_part_fails_the_fetch_and_leaves_nothing_behind()
    {
        var (destination, manifest, _) = await StoreAsync(3 * 1024 * 1024, 1024 * 1024);
        _destinations[destination].Put(manifest.Parts[1].Name, new byte[1024 * 1024]);
        var started = _fetcher.Begin(manifest.BackupId);

        await _fetcher.RunAsync(started.Id, destination, manifest.BackupId, Cancel);

        var failed = _fetcher.Find(started.Id)!;
        Assert.Equal(BackupRunState.Failed, failed.State);
        Assert.Contains("part 2", failed.Error, StringComparison.Ordinal);
        Assert.Null(_downloads.OpenRead(manifest.BackupId));
        Assert.Empty(Directory.EnumerateFiles(Path.Combine(_database.Directory, BackupRunner.RunsFolder)));
    }

    [Fact]
    public async Task A_backup_that_is_gone_is_named()
    {
        var (destination, _, _) = await StoreAsync(10, 1024 * 1024);
        var started = _fetcher.Begin(Guid.NewGuid());

        await _fetcher.RunAsync(started.Id, destination, started.BackupId, Cancel);

        Assert.Contains("no longer on the destination", _fetcher.Find(started.Id)!.Error, StringComparison.Ordinal);
    }
}
