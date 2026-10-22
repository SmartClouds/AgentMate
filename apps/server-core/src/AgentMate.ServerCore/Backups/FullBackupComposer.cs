using System.Formats.Tar;
using System.Globalization;
using System.Text.Json;
using AgentMate.ServerCore.Hosting;

namespace AgentMate.ServerCore.Backups;

/// <summary>Where a full backup finds the core's config, what it calls the server, and how much room a folder has.</summary>
internal sealed record FullBackupOptions(string CoreConfigPath, string HostName, Func<string, long> FreeBytes)
{
    public static FullBackupOptions Default => new(
        CoreApplication.ConfigFile,
        Environment.MachineName,
        path => new DriveInfo(Path.GetPathRoot(Path.GetFullPath(path))!).AvailableFreeSpace);
}

internal sealed record FullBackupResult(BackupManifest Manifest, ServerSnapshot Snapshot);

/// <summary>
/// The whole server in one .tar.gz (E28). The core's state goes first, laid out exactly as an E15
/// backup so restore-stage reads it as it is; then under server/ the core's config, every Docker
/// volume, the images in use, and server.json. Volumes are read
/// live through a helper container: nothing is stopped, so a busy database may be caught mid-write.
/// Images go in when a container uses them or no registry has them (see <see cref="Saved"/>).
/// A volume is spooled to the scratch folder first (a tar entry needs its size before its bytes),
/// with the free space checked before and after.
/// </summary>
internal sealed class FullBackupComposer(CoreDirectories directories, IBackupDocker docker, IServerStateReader state, FullBackupOptions options)
{
    /// <summary>Below this much free space no backup starts.</summary>
    public const long MinimumFreeBytes = 64L * 1024 * 1024;

    /// <summary>What the backups made here are named after.</summary>
    public string HostName => options.HostName;

    public async Task<FullBackupResult> WriteAsync(Stream output, string work, long nowUnixMs, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(output);
        var scratch = Path.Combine(work, $"full-{Guid.NewGuid():N}");
        Directory.CreateDirectory(scratch);
        try
        {
            RequireRoom(work, MinimumFreeBytes);
            var dockerUp = await docker.IsAvailableAsync(cancellationToken);
            var volumes = dockerUp ? await docker.ListVolumesAsync(cancellationToken) : [];
            var images = dockerUp ? await docker.ListImagesAsync(cancellationToken) : [];
            var containers = dockerUp ? await docker.ListContainersAsync(cancellationToken) : [];
            var addresses = await state.AddressesAsync(cancellationToken);
            var firewall = await state.FirewallAsync(cancellationToken);
            var hasConfig = File.Exists(options.CoreConfigPath);

            var volumeEntries = new List<VolumeEntry>();
            var imageEntries = new List<ImageEntry>();
            var manifest = await BackupArchive.WriteAsync(
                directories.Data,
                scratch,
                output,
                CoreVersion.Current,
                options.HostName,
                nowUnixMs,
                cancellationToken,
                async tar =>
                {
                    if (hasConfig)
                    {
                        await tar.WriteEntryAsync(options.CoreConfigPath, ServerSnapshot.ConfigFile, cancellationToken);
                    }

                    foreach (var volume in volumes.OrderBy(v => v.Name, StringComparer.Ordinal))
                    {
                        volumeEntries.Add(await AddVolumeAsync(tar, volume, scratch, cancellationToken));
                    }

                    foreach (var image in images)
                    {
                        imageEntries.Add(await AddImageAsync(tar, image, Saved(image, containers), scratch, cancellationToken));
                    }

                    var snapshot = Snapshot(nowUnixMs, addresses, dockerUp, volumeEntries, imageEntries, containers, firewall, hasConfig);
                    await tar.WriteEntryAsync(
                        new PaxTarEntry(TarEntryType.RegularFile, ServerSnapshot.FileName)
                        {
                            DataStream = new MemoryStream(JsonSerializer.SerializeToUtf8Bytes(snapshot, ServerSnapshotJson.Default.ServerSnapshot)),
                            Mode = UnixFileMode.UserRead | UnixFileMode.UserWrite,
                        },
                        cancellationToken);
                });

            return new FullBackupResult(manifest, Snapshot(nowUnixMs, addresses, dockerUp, volumeEntries, imageEntries, containers, firewall, hasConfig));
        }
        finally
        {
            BackupArchive.TryDelete(scratch);
        }
    }

    private ServerSnapshot Snapshot(
        long nowUnixMs,
        string[] addresses,
        bool dockerUp,
        List<VolumeEntry> volumes,
        List<ImageEntry> images,
        IReadOnlyList<BackupContainer> containers,
        FirewallRulesSnapshot? firewall,
        bool hasConfig) =>
        new(
            ServerSnapshot.CurrentFormat,
            options.HostName,
            nowUnixMs,
            addresses,
            dockerUp,
            [.. volumes],
            [.. images],
            [.. containers.Where(container => container.ComposeProject is null)],
            [.. containers.Where(c => c.Running && c.ComposeProject is not null).Select(c => c.ComposeProject!).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal)],
            firewall,
            hasConfig,
            LiveCopy: true);

    private async Task<VolumeEntry> AddVolumeAsync(TarWriter tar, BackupVolume volume, string scratch, CancellationToken cancellationToken)
    {
        var file = BackupNaming.FileSafe(volume.Name) + ".tar";
        var spool = Path.Combine(scratch, file);
        try
        {
            await using (var output = new FileStream(spool, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1024 * 1024, useAsync: true))
            {
                await docker.ExportVolumeAsync(volume.Name, output, cancellationToken);
            }
        }
        catch (Exception error) when (error is not OperationCanceledException and not BackupRefusedException)
        {
            throw new BackupRefusedException($"The volume {volume.Name} could not be read: {error.Message}", error);
        }

        var size = new FileInfo(spool).Length;
        RequireRoom(scratch, size);
        await tar.WriteEntryAsync(spool, $"{ServerSnapshot.VolumesFolder}/{file}", cancellationToken);
        File.Delete(spool);
        return new VolumeEntry(volume.Name, volume.Driver, volume.Labels, file, size);
    }

    /// <summary>
    /// Whether an image goes into the archive: every image a container uses, so a restore never
    /// depends on a registry still having it, and any tagged image no registry knows. A digest
    /// proves nothing on its own: Docker's containerd store gives images built here one too.
    /// </summary>
    internal static bool Saved(BackupImage image, IReadOnlyList<BackupContainer> containers) =>
        image.Tags.Length > 0
        && (image.RepoDigests.Length == 0 || containers.Any(container => container.Image == image.Id || image.Tags.Contains(container.Image, StringComparer.Ordinal)));

    private async Task<ImageEntry> AddImageAsync(TarWriter tar, BackupImage image, bool save, string scratch, CancellationToken cancellationToken)
    {
        if (!save)
        {
            return new ImageEntry(image.Id, image.Tags, image.RepoDigests, null);
        }

        var id = BackupNaming.FileSafe(image.Id.Replace("sha256:", string.Empty, StringComparison.Ordinal));
        var file = id[..Math.Min(12, id.Length)] + ".tar";
        var spool = Path.Combine(scratch, file);
        try
        {
            await using (var output = new FileStream(spool, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1024 * 1024, useAsync: true))
            {
                // By its tags, not its id: an image saved by id loads back without a name.
                await docker.SaveImagesAsync(image.Tags, output, cancellationToken);
            }
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            throw new BackupRefusedException($"The image {image.Tags[0]} could not be saved: {error.Message}", error);
        }

        RequireRoom(scratch, new FileInfo(spool).Length);
        await tar.WriteEntryAsync(spool, $"{ServerSnapshot.ImagesFolder}/{file}", cancellationToken);
        File.Delete(spool);
        return new ImageEntry(image.Id, image.Tags, image.RepoDigests, file);
    }

    private void RequireRoom(string folder, long needed)
    {
        var free = options.FreeBytes(folder);
        if (free < needed)
        {
            throw new BackupRefusedException(string.Create(
                CultureInfo.InvariantCulture,
                $"There is not enough free space on the server for the backup: {free / (1024 * 1024)} MB free, {Math.Max(1, needed / (1024 * 1024))} MB needed."));
        }
    }
}
