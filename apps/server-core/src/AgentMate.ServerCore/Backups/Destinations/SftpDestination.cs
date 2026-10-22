using System.Text;
using AgentMate.ServerCore.Contracts;
using Renci.SshNet;
using Renci.SshNet.Common;

namespace AgentMate.ServerCore.Backups.Destinations;

/// <summary>
/// An SFTP server (E28), held to the host key pinned in the settings: any other key ends the
/// connection before a password or key is sent. Signs in with a password or a private key. Files go
/// up under a .partial name and are renamed into place.
/// </summary>
internal sealed class SftpDestination : IBackupDestination
{
    private const string TestName = ".agentmate-test";

    private readonly SftpClient _client;
    private readonly string _folder;
    private readonly string? _pinned;
    private readonly List<IDisposable> _keys = [];

    public SftpDestination(BackupDestinationSettings settings, BackupDestinationSecret secret)
    {
        _folder = RemotePaths.Folder(settings.Path);
        _pinned = settings.HostKeySha256;
        var host = settings.Host ?? throw new BackupDestinationException("The SFTP destination has no host.");
        var user = settings.UserName ?? throw new BackupDestinationException("The SFTP destination has no user name.");
        var methods = new List<AuthenticationMethod>();
        if (!string.IsNullOrEmpty(secret.PrivateKey))
        {
            var key = new PrivateKeyFile(new MemoryStream(Encoding.UTF8.GetBytes(secret.PrivateKey)), secret.PrivateKeyPassphrase);
            _keys.Add(key);
            methods.Add(new PrivateKeyAuthenticationMethod(user, key));
        }

        if (!string.IsNullOrEmpty(secret.Password))
        {
            methods.Add(new PasswordAuthenticationMethod(user, secret.Password));
        }

        var connection = new Renci.SshNet.ConnectionInfo(host, settings.Port ?? 22, user, [.. methods])
        {
            Timeout = TimeSpan.FromSeconds(15),
        };
        _client = new SftpClient(connection) { OperationTimeout = TimeSpan.FromMinutes(2) };
        _client.HostKeyReceived += (_, e) =>
        {
            SeenFingerprint = RemotePaths.Fingerprint(e.HostKey);
            e.CanTrust = RemotePaths.Matches(_pinned, e.HostKey);
        };
    }

    /// <summary>The SHA-256 of the host key the server last showed, for the person to confirm.</summary>
    public string? SeenFingerprint { get; private set; }

    /// <summary>Connects only far enough to see the server's host key, with nothing sent to sign in.</summary>
    public static async Task<string?> ProbeHostKeyAsync(string host, int port, CancellationToken cancellationToken)
    {
        await using var probe = new SftpDestination(
            new BackupDestinationSettings(Host: host, Port: port, UserName: "agentmate-probe"),
            new BackupDestinationSecret(Password: "-"));
        try
        {
            await probe._client.ConnectAsync(cancellationToken);
        }
        catch (Exception error) when (error is SshConnectionException or SshAuthenticationException or SshException or System.Net.Sockets.SocketException or TimeoutException)
        {
            // Refused for the host key, as intended; the key was seen first.
        }

        return probe.SeenFingerprint;
    }

    public async Task<string?> TestAsync(CancellationToken cancellationToken)
    {
        try
        {
            await ConnectAsync(cancellationToken);
            await EnsureFolderAsync(cancellationToken);
            var path = RemotePaths.Join(_folder, TestName);
            var probe = Encoding.UTF8.GetBytes(Guid.NewGuid().ToString("N"));
            await _client.UploadFileAsync(new MemoryStream(probe), path, cancellationToken);
            var back = new MemoryStream();
            await _client.DownloadFileAsync(path, back, cancellationToken);
            await _client.DeleteFileAsync(path, cancellationToken);
            return back.ToArray().AsSpan().SequenceEqual(probe) ? null : "A test file came back different.";
        }
        catch (BackupDestinationException refused)
        {
            return refused.Message;
        }
    }

    public Task UploadAsync(BackupUpload upload, CancellationToken cancellationToken) => RunAsync(async () =>
    {
        await ConnectAsync(cancellationToken);
        await EnsureFolderAsync(cancellationToken);
        foreach (var part in upload.Manifest.Parts)
        {
            await using var input = BackupParts.OpenPart(upload.FilePath, part, upload.PartBytes);
            await PutAsync(part.Name, input, upload.Progress, cancellationToken);
        }

        await PutAsync(FolderDestination.ManifestNameOf(upload.Manifest), new MemoryStream(Encoding.UTF8.GetBytes(upload.Manifest.ToJson())), null, cancellationToken);
        return true;
    });

    public Task<IReadOnlyList<BackupManifestFile>> ListAsync(CancellationToken cancellationToken) => RunAsync<IReadOnlyList<BackupManifestFile>>(async () =>
    {
        await ConnectAsync(cancellationToken);
        if (!await _client.ExistsAsync(_folder, cancellationToken))
        {
            return [];
        }

        var manifests = new List<BackupManifestFile>();
        await foreach (var item in _client.ListDirectoryAsync(_folder, cancellationToken))
        {
            if (!item.IsRegularFile || !BackupNaming.IsManifestName(item.Name) || item.Length > BackupManifestFile.MaxBytes)
            {
                continue;
            }

            try
            {
                var bytes = new MemoryStream();
                await _client.DownloadFileAsync(item.FullName, bytes, cancellationToken);
                manifests.Add(BackupManifestFile.Parse(Encoding.UTF8.GetString(bytes.ToArray())));
            }
            catch (BackupRefusedException)
            {
                // Not ours, or damaged.
            }
        }

        return [.. manifests.OrderByDescending(manifest => manifest.CreatedAtUnixMs)];
    });

    public Task<Stream> OpenPartAsync(BackupManifestFile manifest, BackupPartInfo part, CancellationToken cancellationToken) => RunAsync<Stream>(async () =>
    {
        await ConnectAsync(cancellationToken);
        var path = RemotePaths.Join(_folder, part.Name);
        if (!await _client.ExistsAsync(path, cancellationToken))
        {
            throw new BackupDestinationException($"{part.Name} is missing from the SFTP server.");
        }

        var file = RemotePaths.TemporaryFile();
        try
        {
            await _client.DownloadFileAsync(path, file, cancellationToken);
            file.Position = 0;
            return file;
        }
        catch
        {
            await file.DisposeAsync();
            throw;
        }
    });

    public Task DeleteAsync(BackupManifestFile manifest, CancellationToken cancellationToken) => RunAsync(async () =>
    {
        await ConnectAsync(cancellationToken);
        foreach (var name in manifest.Parts.Select(part => part.Name).Prepend(FolderDestination.ManifestNameOf(manifest)))
        {
            var path = RemotePaths.Join(_folder, name);
            if (await _client.ExistsAsync(path, cancellationToken))
            {
                await _client.DeleteFileAsync(path, cancellationToken);
            }
        }

        return true;
    });

    public ValueTask DisposeAsync()
    {
        if (_client.IsConnected)
        {
            _client.Disconnect();
        }

        _client.Dispose();
        foreach (var key in _keys)
        {
            key.Dispose();
        }

        return ValueTask.CompletedTask;
    }

    private async Task ConnectAsync(CancellationToken cancellationToken)
    {
        if (_client.IsConnected)
        {
            return;
        }

        try
        {
            await _client.ConnectAsync(cancellationToken);
        }
        catch (SshConnectionException error) when (_pinned is not null && SeenFingerprint is not null && SeenFingerprint != _pinned)
        {
            throw new BackupDestinationException(
                $"The SFTP server's host key changed: it is now {SeenFingerprint}. If that was expected, test the destination again and confirm the new key.",
                error);
        }
        catch (Exception error) when (error is SshConnectionException or SshAuthenticationException or SshException or System.Net.Sockets.SocketException or TimeoutException)
        {
            throw new BackupDestinationException(Describe(error), error);
        }
    }

    private async Task EnsureFolderAsync(CancellationToken cancellationToken)
    {
        var at = string.Empty;
        foreach (var segment in _folder.Split('/', StringSplitOptions.RemoveEmptyEntries))
        {
            at += "/" + segment;
            if (!await _client.ExistsAsync(at, cancellationToken))
            {
                await _client.CreateDirectoryAsync(at, cancellationToken);
            }
        }
    }

    private async Task PutAsync(string name, Stream input, IProgress<long>? progress, CancellationToken cancellationToken)
    {
        var path = RemotePaths.Join(_folder, name);
        var partial = path + ".partial";
        await _client.UploadFileAsync(progress is null ? input : new CountingStream(input, progress), partial, cancellationToken);
        if (await _client.ExistsAsync(path, cancellationToken))
        {
            await _client.DeleteFileAsync(path, cancellationToken);
        }

        await _client.RenameFileAsync(partial, path, cancellationToken);
    }

    private static async Task<T> RunAsync<T>(Func<Task<T>> work)
    {
        try
        {
            return await work();
        }
        catch (Exception error) when (error is SshException or SftpPathNotFoundException or SftpPermissionDeniedException or IOException or System.Net.Sockets.SocketException or TimeoutException)
        {
            throw new BackupDestinationException(Describe(error), error);
        }
    }

    private static string Describe(Exception error) => error switch
    {
        SshAuthenticationException => "The SFTP server refused the user name, password or key.",
        SshConnectionException when error.Message.Contains("host key", StringComparison.OrdinalIgnoreCase) => "The SFTP server's host key is not the one confirmed.",
        SftpPermissionDeniedException => $"The SFTP server does not allow that: {error.Message}",
        System.Net.Sockets.SocketException or TimeoutException => $"The SFTP server cannot be reached: {error.Message}",
        _ => $"The SFTP server failed: {error.Message}",
    };
}

/// <summary>Reports how many bytes were read through it.</summary>
internal sealed class CountingStream(Stream inner, IProgress<long> progress) : Stream
{
    public override bool CanRead => true;

    public override bool CanSeek => false;

    public override bool CanWrite => false;

    public override long Length => inner.Length;

    public override long Position
    {
        get => inner.Position;
        set => throw new NotSupportedException();
    }

    public override int Read(byte[] buffer, int offset, int count)
    {
        var read = inner.Read(buffer, offset, count);
        progress.Report(read);
        return read;
    }

    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        var read = await inner.ReadAsync(buffer, cancellationToken);
        progress.Report(read);
        return read;
    }

    public override void Flush()
    {
    }

    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

    public override void SetLength(long value) => throw new NotSupportedException();

    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
}
