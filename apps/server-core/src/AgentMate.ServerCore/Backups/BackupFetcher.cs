using System.Collections.Concurrent;
using System.Security.Cryptography;
using AgentMate.ServerCore.Contracts;
using AgentMate.ServerCore.Hosting;
using Hangfire;

namespace AgentMate.ServerCore.Backups;

/// <summary>
/// Fetches a backup from a destination onto this server (E28): its parts joined and each checked
/// against the manifest, the whole checked against its SHA-256, then handed to the E15 download
/// store. There it is both what restore-stage reads (as root, by path) and what the app downloads
/// (GET /api/v1/backups/{backupId}), for an hour.
/// </summary>
internal sealed class BackupFetcher(StoredBackups stored, BackupService downloads, CoreDirectories directories)
{
    private readonly ConcurrentDictionary<Guid, BackupFetchInfo> _fetches = new();

    public BackupFetchInfo Begin(Guid backupId)
    {
        var fetch = new BackupFetchInfo(Guid.NewGuid(), backupId, BackupRunState.Running, 0, 0, null, null);
        _fetches[fetch.Id] = fetch;
        return fetch;
    }

    public BackupFetchInfo? Find(Guid fetchId) => _fetches.GetValueOrDefault(fetchId);

    [AutomaticRetry(Attempts = 0)]
    public async Task RunAsync(Guid fetchId, Guid destinationId, Guid backupId, CancellationToken cancellationToken)
    {
        var folder = Path.Combine(directories.Data, BackupRunner.RunsFolder);
        Directory.CreateDirectory(folder);
        var partial = Path.Combine(folder, $"fetch-{fetchId:N}.partial");
        try
        {
            var (destination, manifest) = await stored.OpenAsync(destinationId, backupId, cancellationToken);
            await using (destination)
            {
                Update(fetchId, fetch => fetch with { SizeBytes = manifest.SizeBytes });
                await using (var output = new FileStream(partial, FileMode.Create, FileAccess.Write, FileShare.None, 1024 * 1024, useAsync: true))
                {
                    var counting = new ProgressStream(output, read => Update(fetchId, fetch => fetch with { BytesDone = fetch.BytesDone + read }));
                    await BackupParts.JoinAsync(manifest.Parts, (part, token) => destination.OpenPartAsync(manifest, part, token), counting, cancellationToken);
                }
            }

            if (manifest.Sha256.Length > 0)
            {
                await using var written = File.OpenRead(partial);
                if (Convert.ToHexStringLower(await SHA256.HashDataAsync(written, cancellationToken)) != manifest.Sha256)
                {
                    throw new BackupRefusedException("The fetched backup does not match the SHA-256 its manifest names.");
                }
            }

            downloads.Adopt(backupId, partial);
            Update(fetchId, fetch => fetch with { State = BackupRunState.Succeeded, Path = downloads.PathFor(backupId) });
        }
        catch (Exception error) when (error is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            BackupArchive.TryDelete(partial);
            Update(fetchId, fetch => fetch with { State = BackupRunState.Failed, Error = error.Message });
        }
    }

    private void Update(Guid fetchId, Func<BackupFetchInfo, BackupFetchInfo> change) =>
        _fetches.AddOrUpdate(fetchId, _ => throw new InvalidOperationException("Unknown fetch."), (_, fetch) => change(fetch));

    /// <summary>Counts what is written through it.</summary>
    private sealed class ProgressStream(Stream inner, Action<long> written) : Stream
    {
        public override bool CanRead => false;

        public override bool CanSeek => false;

        public override bool CanWrite => true;

        public override long Length => inner.Length;

        public override long Position
        {
            get => inner.Position;
            set => throw new NotSupportedException();
        }

        public override void Write(byte[] buffer, int offset, int count)
        {
            inner.Write(buffer, offset, count);
            written(count);
        }

        public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            await inner.WriteAsync(buffer, cancellationToken);
            written(buffer.Length);
        }

        public override void Flush() => inner.Flush();

        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();
    }
}
