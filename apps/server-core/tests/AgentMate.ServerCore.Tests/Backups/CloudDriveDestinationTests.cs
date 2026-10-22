using AgentMate.ServerCore.Backups.Destinations;

namespace AgentMate.ServerCore.Tests.Backups;

/// <summary>Google Drive passes the destination contract against its API's fake, in small chunks.</summary>
public sealed class GoogleDriveDestinationTests : BackupDestinationContract
{
    private const string Folder = "AgentMate Backups";
    private readonly FakeGoogleDrive _drive = new();

    private protected override Task<IBackupDestination> CreateAsync() =>
        Task.FromResult<IBackupDestination>(new CloudDriveDestination(Files(), "Google Drive"));

    private protected override Task PutForeignFileAsync(string name, byte[] contents)
    {
        _drive.AddFile(name, Folder, contents);
        return Task.CompletedTask;
    }

    private GoogleDriveFiles Files() => new(new HttpClient(_drive), "client-1.apps.googleusercontent.com", "client-secret", FakeGoogleDrive.RefreshToken, Folder, chunkBytes: 256 * 1024);

    [Fact]
    public async Task A_big_file_goes_up_in_whole_chunks_and_an_expired_token_is_renewed_once()
    {
        await using var files = Files();
        await files.PutAsync("one", new MemoryStream(new byte[600 * 1024]), 600 * 1024, null, Cancel);
        _drive.ExpireAccessToken();
        await files.PutAsync("two", new MemoryStream([1, 2, 3]), 3, null, Cancel);

        Assert.Equal([256 * 1024, 256 * 1024, 88 * 1024, 3], _drive.ChunkSizes);
        Assert.Equal(2, _drive.TokenRequests);
        Assert.Equal(["one", "two"], (await files.ListAsync(Cancel)).Select(f => f.Name).Order());
    }

    [Fact]
    public async Task Uploading_a_name_again_leaves_one_file_of_that_name()
    {
        await using var files = Files();
        await files.PutAsync("same", new MemoryStream([1]), 1, null, Cancel);
        await files.PutAsync("same", new MemoryStream([2]), 1, null, Cancel);

        var file = Assert.Single(await files.ListAsync(Cancel));
        await using var stream = await files.OpenAsync(file, Cancel);
        Assert.Equal(2, stream.ReadByte());
    }

    [Fact]
    public async Task A_refused_sign_in_is_named()
    {
        await using var destination = new CloudDriveDestination(
            new GoogleDriveFiles(new HttpClient(_drive), "client-1", "client-secret", "revoked", Folder),
            "Google Drive");

        Assert.Contains("sign in again", await destination.TestAsync(Cancel), StringComparison.Ordinal);
    }
}

/// <summary>OneDrive passes the destination contract, and keeps the refresh token Microsoft rotates.</summary>
public sealed class OneDriveDestinationTests : BackupDestinationContract
{
    private readonly FakeOneDrive _drive = new();
    private readonly List<string> _rotated = [];

    private protected override Task<IBackupDestination> CreateAsync() =>
        Task.FromResult<IBackupDestination>(new CloudDriveDestination(Files(), "OneDrive"));

    private protected override Task PutForeignFileAsync(string name, byte[] contents)
    {
        _drive.AddFile(name, contents);
        return Task.CompletedTask;
    }

    private OneDriveFiles Files() => new(
        new HttpClient(_drive),
        "client-1",
        _drive.RefreshToken,
        "AgentMate Backups",
        token =>
        {
            _rotated.Add(token);
            return Task.CompletedTask;
        },
        chunkBytes: 320 * 1024);

    [Fact]
    public async Task Each_new_refresh_token_is_handed_back_to_be_kept()
    {
        await using var files = Files();
        await files.PutAsync("one", new MemoryStream(new byte[700 * 1024]), 700 * 1024, null, Cancel);
        _drive.ExpireAccessToken();
        await files.ListAsync(Cancel);

        Assert.Equal(2, _rotated.Count);
        Assert.Equal(_drive.RefreshToken, _rotated[^1]);
        Assert.Equal([320 * 1024, 320 * 1024, 60 * 1024], _drive.ChunkSizes);
    }
}
