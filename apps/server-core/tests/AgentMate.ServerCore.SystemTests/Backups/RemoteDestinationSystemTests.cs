using AgentMate.ServerCore.Backups.Destinations;
using AgentMate.ServerCore.Contracts;
using AgentMate.ServerCore.Tests.Backups;
using Renci.SshNet;

namespace AgentMate.ServerCore.SystemTests.Backups;

/// <summary>The destination contract over real SFTP, as the test server's user with a password and the pinned host key.</summary>
[Collection(BackupTargetsGroup.Name)]
public sealed class SftpDestinationSystemTests(BackupTargets targets) : BackupDestinationContract
{
    private const string Folder = "/home/keeper/sftp-contract";

    private protected override Task<IBackupDestination> CreateAsync()
    {
        targets.RequireAvailable();
        return Task.FromResult<IBackupDestination>(new SftpDestination(targets.Sftp(Folder), new BackupDestinationSecret(Password: BackupTargets.Password)));
    }

    private protected override Task PutForeignFileAsync(string name, byte[] contents)
    {
        using var client = new SftpClient("127.0.0.1", targets.SshPort, BackupTargets.User, BackupTargets.Password);
        client.HostKeyReceived += (_, e) => e.CanTrust = true;
        client.Connect();
        if (!client.Exists(Folder))
        {
            client.CreateDirectory(Folder);
        }

        client.UploadFile(new MemoryStream(contents), Folder + "/" + name);
        return Task.CompletedTask;
    }
}

/// <summary>The destination contract over plain FTP.</summary>
[Collection(BackupTargetsGroup.Name)]
public sealed class FtpDestinationSystemTests(BackupTargets targets) : BackupDestinationContract
{
    private const string Folder = "/home/keeper/ftp-contract";

    private protected override Task<IBackupDestination> CreateAsync()
    {
        targets.RequireAvailable();
        return Task.FromResult<IBackupDestination>(new FtpDestination(targets.Ftp(Folder, tls: false), new BackupDestinationSecret(Password: BackupTargets.Password)));
    }

    private protected override async Task PutForeignFileAsync(string name, byte[] contents)
    {
        await using var client = new FluentFTP.AsyncFtpClient("127.0.0.1", BackupTargets.User, BackupTargets.Password, targets.FtpPort);
        await client.Connect(Cancel);
        await client.UploadBytes(contents, Folder + "/" + name, FluentFTP.FtpRemoteExists.Overwrite, true, null, Cancel);
    }
}

/// <summary>Host keys and certificates the person did not confirm are refused, with what the server showed.</summary>
[Collection(BackupTargetsGroup.Name)]
public sealed class RemoteDestinationPinningTests(BackupTargets targets)
{
    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private static readonly BackupDestinationSecret _secret = new(Password: BackupTargets.Password);

    [Fact]
    public async Task An_sftp_server_with_another_host_key_is_refused_before_signing_in()
    {
        targets.RequireAvailable();
        await using var destination = new SftpDestination(targets.Sftp("/home/keeper/pin", new string('0', 64)), _secret);

        var problem = await destination.TestAsync(Cancel);

        Assert.Contains("host key", problem, StringComparison.Ordinal);
        Assert.Contains(targets.HostKeySha256, problem, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_wrong_password_is_named_as_such()
    {
        targets.RequireAvailable();
        await using var destination = new SftpDestination(targets.Sftp("/home/keeper/pin"), new BackupDestinationSecret(Password: "not the password"));

        Assert.Contains("refused", await destination.TestAsync(Cancel), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Ftps_with_a_self_signed_certificate_works_once_it_is_pinned()
    {
        targets.RequireAvailable();
        string seen;
        await using (var unpinned = new FtpDestination(targets.Ftp("/home/keeper/ftps", tls: true), _secret))
        {
            var problem = await unpinned.TestAsync(Cancel);
            Assert.Contains("not trusted", problem, StringComparison.Ordinal);
            seen = unpinned.SeenFingerprint!;
            Assert.Contains(seen, problem, StringComparison.Ordinal);
        }

        await using var pinned = new FtpDestination(targets.Ftp("/home/keeper/ftps", tls: true, pin: seen), _secret);
        Assert.Null(await pinned.TestAsync(Cancel));
    }

    [Fact]
    public async Task A_part_that_is_not_there_is_named()
    {
        targets.RequireAvailable();
        await using var destination = new SftpDestination(targets.Sftp("/home/keeper/missing"), _secret);
        var manifest = new AgentMate.ServerCore.Backups.BackupManifestFile(
            1, Guid.NewGuid(), null, "x", 0, 1, new string('a', 64), "1", "k", [new(1, "agentmate-x.ambackup", 1, new string('a', 64))]);

        var error = await Assert.ThrowsAsync<BackupDestinationException>(() =>
            destination.OpenPartAsync(manifest, manifest.Parts[0], Cancel));

        Assert.Contains("missing", error.Message, StringComparison.Ordinal);
    }
}
