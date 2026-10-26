using System.Globalization;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using Runova.ServerCore.Compatibility;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Hosting;

namespace Runova.ServerCore.Backups;

/// <summary>
/// Makes backups in the state folder's backups/ (root only), one at a time. A backup waits there an
/// hour at most for the app to download and delete it: it is encrypted, but a copy on the machine it
/// protects is no backup, and no reason to keep it.
/// </summary>
internal sealed partial class BackupService(CoreDirectories directories, TimeProvider time) : IDisposable
{
    public static readonly TimeSpan Keep = TimeSpan.FromHours(1);

    private const string Extension = BackupNaming.Extension;
    private const UnixFileMode OwnerOnly = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute;

    private readonly SemaphoreSlim _gate = new(1, 1);

    public string Root => Path.Combine(directories.Data, "backups");

    private long Now => time.GetUtcNow().ToUnixTimeMilliseconds();

    public void Dispose() => _gate.Dispose();

    public async Task<BackupInfo> CreateAsync(string passphrase, CancellationToken cancellationToken)
    {
        if (BackupCrypto.PassphraseProblem(passphrase) is { } problem)
        {
            throw new BackupRefusedException(problem);
        }

        if (!await _gate.WaitAsync(TimeSpan.Zero, cancellationToken))
        {
            throw new BackupRefusedException("A backup is being made already. Wait for it to finish.");
        }

        var id = Guid.NewGuid();
        var work = Path.Combine(Root, $".work-{id:N}");
        var target = PathOf(id);
        try
        {
            Sweep();
            EnsurePrivate(Root);
            EnsurePrivate(work);
            var now = Now;
            var payload = Path.Combine(work, "payload.tar.gz");
            BackupManifest manifest;
            await using (var output = Create(payload))
            {
                manifest = await BackupArchive.WriteAsync(directories.Data, work, output, CoreVersion.Current, Environment.MachineName, now, cancellationToken);
            }

            var partial = target + ".partial";
            await using (var input = File.OpenRead(payload))
            await using (var output = Create(partial))
            {
                await BackupCrypto.EncryptAsync(input, output, passphrase, now, cancellationToken);
                output.Flush(flushToDisk: true);
            }

            File.Move(partial, target);
            string sha256;
            await using (var written = File.OpenRead(target))
            {
                sha256 = Convert.ToHexStringLower(await SHA256.HashDataAsync(written, cancellationToken));
            }

            return new BackupInfo(
                id,
                $"runova-backup-{FileSafe(manifest.HostName)}-{DateTimeOffset.FromUnixTimeMilliseconds(now).ToString("yyyyMMdd-HHmm", CultureInfo.InvariantCulture)}{Extension}",
                new FileInfo(target).Length,
                sha256,
                now,
                now + (long)Keep.TotalMilliseconds,
                manifest.CoreVersion,
                manifest.Contents);
        }
        catch
        {
            BackupArchive.TryDelete(target);
            throw;
        }
        finally
        {
            BackupArchive.TryDelete(work);
            BackupArchive.TryDelete(target + ".partial");
            _gate.Release();
        }
    }

    /// <summary>
    /// Takes a finished server backup (E28) to wait here for the app like one made on demand: the
    /// same name, the same hour.
    /// </summary>
    public void Adopt(Guid id, string file)
    {
        EnsurePrivate(Root);
        var target = PathOf(id);
        File.Move(file, target, overwrite: true);
        File.SetLastWriteTimeUtc(target, time.GetUtcNow().UtcDateTime);
    }

    /// <summary>The backup's file to send, or null when it is gone (downloaded and deleted, or expired).</summary>
    public FileStream? OpenRead(Guid id)
    {
        Sweep();
        var path = PathOf(id);
        return File.Exists(path) ? new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 81_920, useAsync: true) : null;
    }

    public bool Delete(Guid id)
    {
        var path = PathOf(id);
        if (!File.Exists(path))
        {
            return false;
        }

        File.Delete(path);
        return true;
    }

    /// <summary>Removes backups past their hour, and anything a stopped run left behind.</summary>
    public void Sweep()
    {
        if (!Directory.Exists(Root))
        {
            return;
        }

        var cutoff = time.GetUtcNow() - Keep;
        foreach (var entry in Directory.EnumerateFileSystemEntries(Root))
        {
            if (new FileInfo(entry).LastWriteTimeUtc < cutoff.UtcDateTime || (Path.GetFileName(entry).StartsWith(".work-", StringComparison.Ordinal) && _gate.CurrentCount > 0))
            {
                BackupArchive.TryDelete(entry);
            }
        }
    }

    /// <summary>Where a backup waits; restore-stage reads it from here as root.</summary>
    public string PathFor(Guid id) => PathOf(id);

    /// <summary>A backup made before the rename waits under the old extension until it is fetched.</summary>
    private string PathOf(Guid id)
    {
        var path = Path.Combine(Root, id.ToString("N") + Extension);
        var legacy = Path.Combine(Root, id.ToString("N") + LegacyNames.BackupExtension);
        return !File.Exists(path) && File.Exists(legacy) ? legacy : path;
    }

    private static FileStream Create(string path)
    {
        var options = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write, Share = FileShare.None, Options = FileOptions.Asynchronous };
        if (!OperatingSystem.IsWindows())
        {
            options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        }

        return new FileStream(path, options);
    }

    private static void EnsurePrivate(string path)
    {
        if (OperatingSystem.IsWindows())
        {
            Directory.CreateDirectory(path);
            return;
        }

        Directory.CreateDirectory(path, OwnerOnly);
        File.SetUnixFileMode(path, OwnerOnly);
    }

    private static string FileSafe(string name)
    {
        var safe = Unsafe().Replace(name, "-").Trim('-');
        return safe.Length == 0 ? "server" : safe[..Math.Min(safe.Length, 40)];
    }

    [GeneratedRegex("[^A-Za-z0-9._-]+", RegexOptions.CultureInvariant)]
    private static partial Regex Unsafe();
}
