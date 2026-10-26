using System.Formats.Tar;
using System.IO.Compression;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Uploads;

namespace Runova.ServerCore.Backups;

/// <summary>What a backup holds, written inside it (never in the clear).</summary>
internal sealed record BackupManifest(
    int Format,
    string CoreVersion,
    long CreatedAtUnixMs,
    string HostName,
    string? LatestMigration,
    BackupContents Contents);

[JsonSerializable(typeof(BackupManifest))]
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, WriteIndented = true)]
internal sealed partial class BackupManifestJson : JsonSerializerContext;

/// <summary>
/// The inside of a backup, a .tar.gz of the core's state: a consistent copy of the database
/// (VACUUM INTO, which reads one snapshot while the core keeps writing), the Data Protection keys
/// that unseal what the database keeps encrypted (certificate keys, the ACME account, stored
/// registry passwords), the stacks' files, and a manifest. Sites and certificates live in the
/// database. Job logs, firewall change sets on disk and earlier backups stay out.
/// </summary>
internal static class BackupArchive
{
    public const string ManifestName = "backup.json";

    /// <summary>The folders of the state folder that go into a backup.</summary>
    public static readonly string[] Folders = ["keys", "stacks"];

    private const int ManifestFormat = 1;
    private const UnixFileMode PrivateFile = UnixFileMode.UserRead | UnixFileMode.UserWrite;
    private const UnixFileMode PrivateFolder = PrivateFile | UnixFileMode.UserExecute;

    /// <summary>What a restore will unpack at most.</summary>
    public static readonly TarExtractionLimits RestoreLimits = new() { MaxTotalBytes = 4L * 1024 * 1024 * 1024, MaxEntries = 200_000 };

    /// <summary>
    /// The unpack limits for a payload of this size (E28): a full backup holds volumes and images,
    /// so the E15 limit grows with it, up to fifty times the compressed size (a guard against a
    /// crafted archive that unpacks into far more than it weighs) and never past the free space.
    /// </summary>
    public static TarExtractionLimits RestoreLimitsFor(long payloadBytes, long freeBytes) => new()
    {
        MaxTotalBytes = Math.Max(RestoreLimits.MaxTotalBytes, Math.Min(payloadBytes * 50, Math.Max(0, freeBytes - (512L * 1024 * 1024)))),
        MaxEntries = 5_000_000,
    };

    /// <summary>
    /// Writes the .tar.gz to <paramref name="output"/>; <paramref name="work"/> is a private scratch
    /// folder. <paramref name="more"/> adds entries after the core's own (a full backup's server/).
    /// </summary>
    public static async Task<BackupManifest> WriteAsync(
        string dataDirectory,
        string work,
        Stream output,
        string coreVersion,
        string hostName,
        long nowUnixMs,
        CancellationToken cancellationToken,
        Func<TarWriter, Task>? more = null)
    {
        ArgumentNullException.ThrowIfNull(output);
        var snapshot = Path.Combine(work, CoreDatabase.FileName);
        await SnapshotDatabaseAsync(CoreDatabase.PathIn(dataDirectory), snapshot, cancellationToken);
        var (contents, migration) = await DescribeAsync(snapshot, dataDirectory, cancellationToken);
        var manifest = new BackupManifest(ManifestFormat, coreVersion, nowUnixMs, hostName, migration, contents);

        await using (var gzip = new GZipStream(output, CompressionLevel.Optimal, leaveOpen: true))
        await using (var tar = new TarWriter(gzip, TarEntryFormat.Pax, leaveOpen: true))
        {
            var manifestEntry = new PaxTarEntry(TarEntryType.RegularFile, ManifestName)
            {
                DataStream = new MemoryStream(JsonSerializer.SerializeToUtf8Bytes(manifest, BackupManifestJson.Default.BackupManifest)),
                Mode = PrivateFile,
            };
            await tar.WriteEntryAsync(manifestEntry, cancellationToken);
            await tar.WriteEntryAsync(snapshot, CoreDatabase.FileName, cancellationToken);
            foreach (var folder in Folders)
            {
                await AddFolderAsync(tar, Path.Combine(dataDirectory, folder), folder, cancellationToken);
            }

            if (more is not null)
            {
                await more(tar);
            }
        }

        return manifest;
    }

    /// <summary>
    /// Unpacks a backup's .tar.gz into <paramref name="into"/> (a folder that does not exist yet) and
    /// checks it can be run: a manifest, a database this core's migrations know. The copy is then
    /// made safe to start: every session it held ends (its devices stay), and a firewall change it
    /// was waiting on is closed, since this server never made it.
    /// </summary>
    public static async Task<BackupManifest> StageAsync(
        Stream payload,
        string into,
        IReadOnlyCollection<string> knownMigrations,
        long nowUnixMs,
        CancellationToken cancellationToken,
        TarExtractionLimits? limits = null)
    {
        ArgumentNullException.ThrowIfNull(knownMigrations);
        try
        {
            await SafeTarExtractor.ExtractAsync(payload, into, limits ?? RestoreLimits, cancellationToken);
        }
        catch (ArchiveRejectedException rejected)
        {
            throw new BackupRefusedException($"The backup's contents were refused: {rejected.Message}", rejected);
        }

        try
        {
            var manifest = ReadManifest(into);
            var database = CoreDatabase.PathIn(into);
            if (!File.Exists(database))
            {
                throw new BackupRefusedException("The backup holds no database.");
            }

            await using (var db = new CoreDbContext(CoreDatabase.Options(database)))
            {
                var applied = await db.Database.GetAppliedMigrationsAsync(cancellationToken);
                var unknown = applied.Where(migration => !knownMigrations.Contains(migration)).ToList();
                if (unknown.Count > 0)
                {
                    throw new BackupRefusedException(
                        $"The backup comes from a newer server core ({manifest.CoreVersion}). Update this server's core first.");
                }

                await db.DeviceSessions.Where(session => session.RevokedAt == null)
                    .ExecuteUpdateAsync(update => update.SetProperty(session => session.RevokedAt, nowUnixMs), cancellationToken);
                await db.FirewallChangeSets
                    .Where(change => change.State == FirewallChangeState.Applying || change.State == FirewallChangeState.AwaitingConfirmation)
                    .ExecuteUpdateAsync(
                        update => update
                            .SetProperty(change => change.State, FirewallChangeState.Failed)
                            .SetProperty(change => change.FinishedAt, nowUnixMs)
                            .SetProperty(change => change.Error, "Restored from a backup before this change was decided."),
                        cancellationToken);
            }

            CoreDatabase.ReleasePool(database);
            Restrict(into);
            return manifest;
        }
        catch
        {
            CoreDatabase.ReleasePool(CoreDatabase.PathIn(into));
            TryDelete(into);
            throw;
        }
    }

    /// <summary>The Owners of a staged backup, so the app can offer to sign in as one after the restore.</summary>
    public static async Task<string[]> OwnersAsync(string folder, CancellationToken cancellationToken)
    {
        await using var db = new CoreDbContext(CoreDatabase.Options(CoreDatabase.PathIn(folder)));
        var owners = await db.UserRoles
            .Join(db.Roles.Where(role => role.Name == Security.CoreRoles.Owner), link => link.RoleId, role => role.Id, (link, _) => link.UserId)
            .Join(db.Users, id => id, user => user.Id, (_, user) => user.UserName)
            .ToListAsync(cancellationToken);
        await db.Database.CloseConnectionAsync();
        CoreDatabase.ReleasePool(CoreDatabase.PathIn(folder));
        return [.. owners.OfType<string>().Order(StringComparer.Ordinal)];
    }

    public static BackupManifest ReadManifest(string folder)
    {
        try
        {
            var manifest = JsonSerializer.Deserialize(File.ReadAllBytes(Path.Combine(folder, ManifestName)), BackupManifestJson.Default.BackupManifest);
            return manifest is { Format: ManifestFormat }
                ? manifest
                : throw new BackupRefusedException("This backup was made by a newer Runova. Update the server core first.");
        }
        catch (Exception error) when (error is IOException or JsonException)
        {
            throw new BackupRefusedException("The backup holds no readable manifest.", error);
        }
    }

    /// <summary>Root only, as the core's state folder: 0700 folders, 0600 files.</summary>
    public static void Restrict(string root)
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        File.SetUnixFileMode(root, PrivateFolder);
        foreach (var entry in Directory.EnumerateFileSystemEntries(root, "*", SearchOption.AllDirectories))
        {
            if (new FileInfo(entry).LinkTarget is not null)
            {
                continue;
            }

            File.SetUnixFileMode(entry, Directory.Exists(entry) ? PrivateFolder : PrivateFile);
        }
    }

    public static void TryDelete(string path)
    {
        try
        {
            if (Directory.Exists(path))
            {
                Directory.Delete(path, recursive: true);
            }
            else if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            // Left for the next backup's clean-up.
        }
    }

    private static async Task SnapshotDatabaseAsync(string database, string snapshot, CancellationToken cancellationToken)
    {
        if (!File.Exists(database))
        {
            throw new BackupRefusedException("The core has no database to back up yet.");
        }

        var connectionString = new SqliteConnectionStringBuilder { DataSource = database, Mode = SqliteOpenMode.ReadOnly, Pooling = false }.ToString();
        await using var connection = new SqliteConnection(connectionString);
        await connection.OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = "VACUUM INTO $target";
        command.Parameters.AddWithValue("$target", snapshot);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static async Task<(BackupContents Contents, string? Migration)> DescribeAsync(string snapshot, string dataDirectory, CancellationToken cancellationToken)
    {
        await using var db = new CoreDbContext(CoreDatabase.Options(snapshot));
        var contents = new BackupContents(
            await db.Users.CountAsync(cancellationToken),
            await db.Devices.CountAsync(device => device.RevokedAt == null, cancellationToken),
            await db.Stacks.CountAsync(cancellationToken),
            await db.Sites.CountAsync(cancellationToken),
            await db.Certificates.CountAsync(cancellationToken),
            new FileInfo(snapshot).Length,
            Folders.Sum(folder => Directory.Exists(Path.Combine(dataDirectory, folder))
                ? Directory.EnumerateFiles(Path.Combine(dataDirectory, folder), "*", SearchOption.AllDirectories).Count()
                : 0));
        var migration = (await db.Database.GetAppliedMigrationsAsync(cancellationToken)).LastOrDefault();
        await db.Database.CloseConnectionAsync();
        CoreDatabase.ReleasePool(snapshot);
        return (contents, migration);
    }

    /// <summary>Regular files and folders only: a link in the state folder is not followed or kept.</summary>
    private static async Task AddFolderAsync(TarWriter tar, string folder, string name, CancellationToken cancellationToken)
    {
        if (!Directory.Exists(folder) || new DirectoryInfo(folder).LinkTarget is not null)
        {
            return;
        }

        await tar.WriteEntryAsync(new PaxTarEntry(TarEntryType.Directory, name + "/") { Mode = PrivateFolder }, cancellationToken);
        foreach (var entry in Directory.EnumerateFileSystemEntries(folder).Order(StringComparer.Ordinal))
        {
            var child = $"{name}/{Path.GetFileName(entry)}";
            var info = new FileInfo(entry);
            if (info.LinkTarget is not null)
            {
                continue;
            }

            if (Directory.Exists(entry))
            {
                await AddFolderAsync(tar, entry, child, cancellationToken);
            }
            else
            {
                await tar.WriteEntryAsync(entry, child, cancellationToken);
            }
        }
    }
}
