using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;

namespace Runova.ServerCore.Data;

/// <summary>
/// Where the database lives and how it is opened. Write-ahead logging lets readers carry on while
/// one writer works; a write transaction takes SQLite's write lock as it begins, so a read and the
/// write that depends on it (the next audit hash) cannot be split by another process.
/// </summary>
internal static class CoreDatabase
{
    public const string FileName = "core.db";

    /// <summary>How long a statement waits for another writer before it gives up.</summary>
    private const int BusyTimeoutSeconds = 30;

    public static string PathIn(string dataDirectory) => Path.Combine(dataDirectory, FileName);

    public static string ConnectionString(string path) => new SqliteConnectionStringBuilder
    {
        DataSource = path,
        Mode = SqliteOpenMode.ReadWriteCreate,
        Pooling = true,
        DefaultTimeout = BusyTimeoutSeconds,
    }.ToString();

    public static DbContextOptions<CoreDbContext> Options(string path)
    {
        var options = new DbContextOptionsBuilder<CoreDbContext>();
        Configure(options, path);
        return options.Options;
    }

    public static void Configure(DbContextOptionsBuilder options, string path)
    {
        ArgumentNullException.ThrowIfNull(options);
        options.UseSqlite(ConnectionString(path));
    }

    /// <summary>
    /// Closes the pooled connections to one database file, so it can be moved or deleted. Never
    /// <see cref="SqliteConnection.ClearAllPools"/> in the core: that empties every pool in the
    /// process, and Microsoft.Data.Sqlite 10.0.12 can then take back a connection another thread
    /// is still using and dispose its handle under it (dotnet/efcore#39008). The core's own database
    /// is pooled the whole time it serves requests, a backup included.
    /// </summary>
    public static void ReleasePool(string path)
    {
        using var connection = new SqliteConnection(ConnectionString(path));
        SqliteConnection.ClearPool(connection);
    }

    /// <summary>BEGIN IMMEDIATE: the write lock is held from the first statement until commit.</summary>
    public static SqliteTransaction BeginWrite(SqliteConnection connection)
    {
        ArgumentNullException.ThrowIfNull(connection);
        return connection.BeginTransaction(deferred: false);
    }

    /// <summary>
    /// A BEGIN IMMEDIATE transaction for an EF context, for a read and the write that depends on it
    /// (the next revision of a counter, the next hash of a chain).
    /// </summary>
    public static async Task<Microsoft.EntityFrameworkCore.Storage.IDbContextTransaction> BeginWriteAsync(
        CoreDbContext db,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(db);
        var connection = (SqliteConnection)db.Database.GetDbConnection();
        await connection.OpenAsync(cancellationToken);
        return await db.Database.UseTransactionAsync(BeginWrite(connection), cancellationToken)
            ?? throw new InvalidOperationException("Could not start a write transaction.");
    }

    /// <summary>Creates or upgrades the database, in write-ahead mode and readable by its owner alone.</summary>
    public static async Task PrepareAsync(string path, CancellationToken cancellationToken)
    {
        // systemd creates the state folder (0700) when the service first starts. An admin command
        // run before that creates it just as private, since the encryption keys live there too.
        var directory = Path.GetDirectoryName(Path.GetFullPath(path));
        if (directory is not null && !Directory.Exists(directory))
        {
            if (OperatingSystem.IsWindows())
            {
                Directory.CreateDirectory(directory);
            }
            else
            {
                Directory.CreateDirectory(
                    directory,
                    UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            }
        }

        await using (var db = new CoreDbContext(Options(path)))
        {
            await db.Database.MigrateAsync(cancellationToken);
            // Persistent in the file once set, so this is a no-op after the first start.
            await db.Database.ExecuteSqlRawAsync("PRAGMA journal_mode=WAL;", cancellationToken);
        }

        RestrictFiles(path);
    }

    /// <summary>
    /// The service runs with UMask=0077, but an admin command runs under sudo's umask; either way
    /// the files end up 0600. (The data folder itself is 0700 as well.)
    /// </summary>
    public static void RestrictFiles(string path)
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        foreach (var file in new[] { path, path + "-wal", path + "-shm" })
        {
            if (File.Exists(file))
            {
                File.SetUnixFileMode(file, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            }
        }
    }
}
