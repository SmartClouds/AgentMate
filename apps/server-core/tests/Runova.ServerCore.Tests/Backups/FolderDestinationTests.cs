using Runova.ServerCore.Backups.Destinations;

namespace Runova.ServerCore.Tests.Backups;

/// <summary>A folder on the server passes the destination contract, and is made when missing.</summary>
public sealed class FolderDestinationTests : BackupDestinationContract
{
    private readonly string _folder = Path.Combine(Path.GetTempPath(), $"am-folder-{Guid.NewGuid():N}", "nested");

    private protected override Task<IBackupDestination> CreateAsync() => Task.FromResult<IBackupDestination>(new FolderDestination(_folder));

    private protected override async Task PutForeignFileAsync(string name, byte[] contents)
    {
        Directory.CreateDirectory(_folder);
        await File.WriteAllBytesAsync(Path.Combine(_folder, name), contents, Cancel);
    }

    public override async ValueTask DisposeAsync()
    {
        await base.DisposeAsync();
        TestFolders.Delete(Path.GetDirectoryName(_folder)!);
    }

    [Fact]
    public async Task Nothing_is_left_behind_but_the_backup_itself()
    {
        Assert.Null(await Destination.TestAsync(Cancel));

        Assert.Empty(Directory.EnumerateFileSystemEntries(_folder));
    }
}
