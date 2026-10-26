using System.Net.Security;
using System.Text;
using FluentFTP;
using FluentFTP.Exceptions;
using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.Backups.Destinations;

/// <summary>
/// An FTP server (E28), with explicit TLS when the settings ask. A certificate the system trusts is
/// accepted; any other only when its SHA-256 is the one pinned in the settings, which the person
/// confirmed after a test. Files go up under a .partial name and are renamed into place.
/// </summary>
internal sealed class FtpDestination : IBackupDestination
{
    private const string TestName = ".runova-test";

    private readonly AsyncFtpClient _client;
    private readonly string _folder;
    private readonly string? _pinned;
    private bool _connected;

    public FtpDestination(BackupDestinationSettings settings, BackupDestinationSecret secret)
    {
        _folder = RemotePaths.Folder(settings.Path);
        _pinned = settings.HostKeySha256;
        var config = new FtpConfig
        {
            EncryptionMode = settings.Tls == true ? FtpEncryptionMode.Explicit : FtpEncryptionMode.None,
            DataConnectionType = FtpDataConnectionType.AutoPassive,
            ConnectTimeout = 15_000,
            ReadTimeout = 60_000,
            DataConnectionConnectTimeout = 15_000,
            DataConnectionReadTimeout = 60_000,
            RetryAttempts = 2,
        };
        _client = new AsyncFtpClient(settings.Host, settings.UserName, secret.Password, settings.Port ?? 21, config);
        _client.ValidateCertificate += (_, e) =>
        {
            SeenFingerprint = e.Certificate is null ? null : RemotePaths.Fingerprint(e.Certificate.GetRawCertData());
            e.Accept = e.PolicyErrors == SslPolicyErrors.None || (e.Certificate is not null && RemotePaths.Matches(_pinned, e.Certificate.GetRawCertData()));
        };
    }

    /// <summary>The SHA-256 of the certificate the server last showed, for the person to confirm.</summary>
    public string? SeenFingerprint { get; private set; }

    public async Task<string?> TestAsync(CancellationToken cancellationToken)
    {
        try
        {
            await ConnectAsync(cancellationToken);
            await _client.CreateDirectory(_folder, true, cancellationToken);
            var path = RemotePaths.Join(_folder, TestName);
            var probe = Encoding.UTF8.GetBytes(Guid.NewGuid().ToString("N"));
            await _client.UploadBytes(probe, path, FtpRemoteExists.Overwrite, false, null, cancellationToken);
            var back = await _client.DownloadBytes(path, cancellationToken);
            await _client.DeleteFile(path, cancellationToken);
            return back.AsSpan().SequenceEqual(probe) ? null : "A test file came back different.";
        }
        catch (BackupDestinationException refused)
        {
            return refused.Message;
        }
        catch (Exception error) when (error is FtpException or IOException or System.Net.Sockets.SocketException or TimeoutException or System.Security.Authentication.AuthenticationException)
        {
            return Describe(error);
        }
    }

    public async Task UploadAsync(BackupUpload upload, CancellationToken cancellationToken)
    {
        await RunAsync(async () =>
        {
            await ConnectAsync(cancellationToken);
            await _client.CreateDirectory(_folder, true, cancellationToken);
            foreach (var part in upload.Manifest.Parts)
            {
                await using var input = BackupParts.OpenPart(upload.FilePath, part, upload.PartBytes);
                await PutAsync(part.Name, input, upload.Progress, cancellationToken);
            }

            await PutAsync(FolderDestination.ManifestNameOf(upload.Manifest), new MemoryStream(Encoding.UTF8.GetBytes(upload.Manifest.ToJson())), null, cancellationToken);
        });
    }

    public async Task<IReadOnlyList<BackupManifestFile>> ListAsync(CancellationToken cancellationToken) =>
        await RunAsync<IReadOnlyList<BackupManifestFile>>(async () =>
        {
            await ConnectAsync(cancellationToken);
            if (!await _client.DirectoryExists(_folder, cancellationToken))
            {
                return [];
            }

            var manifests = new List<BackupManifestFile>();
            foreach (var item in await _client.GetListing(_folder, cancellationToken))
            {
                if (item.Type != FtpObjectType.File || !BackupNaming.IsManifestName(item.Name) || item.Size > BackupManifestFile.MaxBytes)
                {
                    continue;
                }

                try
                {
                    var bytes = await _client.DownloadBytes(RemotePaths.Join(_folder, item.Name), cancellationToken);
                    manifests.Add(BackupManifestFile.Parse(Encoding.UTF8.GetString(bytes)));
                }
                catch (BackupRefusedException)
                {
                    // Not ours, or damaged.
                }
            }

            return [.. manifests.OrderByDescending(manifest => manifest.CreatedAtUnixMs)];
        });

    public async Task<Stream> OpenPartAsync(BackupManifestFile manifest, BackupPartInfo part, CancellationToken cancellationToken) =>
        await RunAsync<Stream>(async () =>
        {
            await ConnectAsync(cancellationToken);
            var file = RemotePaths.TemporaryFile();
            try
            {
                if (!await _client.DownloadStream(file, RemotePaths.Join(_folder, part.Name), 0, null, cancellationToken))
                {
                    throw new BackupDestinationException($"{part.Name} is missing from the FTP server.");
                }

                file.Position = 0;
                return file;
            }
            catch
            {
                await file.DisposeAsync();
                throw;
            }
        });

    public async Task DeleteAsync(BackupManifestFile manifest, CancellationToken cancellationToken)
    {
        await RunAsync(async () =>
        {
            await ConnectAsync(cancellationToken);
            await DeleteIfThereAsync(FolderDestination.ManifestNameOf(manifest), cancellationToken);
            foreach (var part in manifest.Parts)
            {
                await DeleteIfThereAsync(part.Name, cancellationToken);
            }
        });
    }

    public async ValueTask DisposeAsync()
    {
        try
        {
            if (_client.IsConnected)
            {
                await _client.Disconnect(CancellationToken.None);
            }
        }
        catch (Exception error) when (error is FtpException or IOException or System.Net.Sockets.SocketException or TimeoutException)
        {
            // Closing a connection that is gone already.
        }

        await _client.DisposeAsync();
    }

    private async Task ConnectAsync(CancellationToken cancellationToken)
    {
        if (_connected && _client.IsConnected)
        {
            return;
        }

        try
        {
            await _client.Connect(cancellationToken);
            _connected = true;
        }
        catch (Exception error) when (error is System.Security.Authentication.AuthenticationException || error.InnerException is System.Security.Authentication.AuthenticationException)
        {
            throw new BackupDestinationException(
                SeenFingerprint is null
                    ? "The FTP server's TLS certificate was refused."
                    : $"The FTP server's TLS certificate is not trusted. Its SHA-256 is {SeenFingerprint}; confirm it to pin it.",
                error);
        }
    }

    private async Task PutAsync(string name, Stream input, IProgress<long>? progress, CancellationToken cancellationToken)
    {
        var path = RemotePaths.Join(_folder, name);
        var partial = path + ".partial";
        long sent = 0;
        var report = progress is null ? null : new Progress<FtpProgress>(p =>
        {
            progress.Report(p.TransferredBytes - sent);
            sent = p.TransferredBytes;
        });
        var status = await _client.UploadStream(input, partial, FtpRemoteExists.Overwrite, false, report, cancellationToken);
        if (status != FtpStatus.Success)
        {
            throw new BackupDestinationException($"The FTP server did not take {name}.");
        }

        if (await _client.FileExists(path, cancellationToken))
        {
            await _client.DeleteFile(path, cancellationToken);
        }

        await _client.Rename(partial, path, cancellationToken);
    }

    private async Task DeleteIfThereAsync(string name, CancellationToken cancellationToken)
    {
        var path = RemotePaths.Join(_folder, name);
        if (await _client.FileExists(path, cancellationToken))
        {
            await _client.DeleteFile(path, cancellationToken);
        }
    }

    private static async Task RunAsync(Func<Task> work) => await RunAsync(async () =>
    {
        await work();
        return true;
    });

    private static async Task<T> RunAsync<T>(Func<Task<T>> work)
    {
        try
        {
            return await work();
        }
        catch (Exception error) when (error is FtpException or IOException or System.Net.Sockets.SocketException or TimeoutException)
        {
            throw new BackupDestinationException(Describe(error), error);
        }
    }

    private static string Describe(Exception error) => error switch
    {
        FtpAuthenticationException => "The FTP server refused the user name or password.",
        System.Net.Sockets.SocketException or TimeoutException => $"The FTP server cannot be reached: {error.Message}",
        _ => $"The FTP server failed: {error.Message}",
    };
}
