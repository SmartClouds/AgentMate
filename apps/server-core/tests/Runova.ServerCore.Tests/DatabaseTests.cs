using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Runova.ServerCore.Data;

namespace Runova.ServerCore.Tests;

/// <summary>
/// The core's SQLite database: migrated on start, in write-ahead mode so readers never wait on the
/// writer, private to root, and with writes that take the lock up front so two processes (the
/// service and a break-glass admin command) can never interleave a read-then-write.
/// </summary>
public sealed class DatabaseTests
{
    [Fact]
    public async Task A_fresh_database_is_migrated_and_uses_write_ahead_logging()
    {
        await using var database = await TestDatabase.CreateAsync();
        await using var db = await database.Contexts.CreateDbContextAsync(TestContext.Current.CancellationToken);

        Assert.Empty(await db.Database.GetPendingMigrationsAsync(TestContext.Current.CancellationToken));
        var connection = db.Database.GetDbConnection();
        await connection.OpenAsync(TestContext.Current.CancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = "PRAGMA journal_mode";

        Assert.Equal("wal", (string?)await command.ExecuteScalarAsync(TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task Preparing_twice_changes_nothing()
    {
        await using var database = await TestDatabase.CreateAsync();

        await CoreDatabase.PrepareAsync(database.Path, TestContext.Current.CancellationToken);

        await using var db = await database.Contexts.CreateDbContextAsync(TestContext.Current.CancellationToken);
        Assert.Empty(await db.Database.GetPendingMigrationsAsync(TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task A_write_transaction_takes_the_write_lock_as_it_begins()
    {
        await using var database = await TestDatabase.CreateAsync();
        await using var first = new SqliteConnection(CoreDatabase.ConnectionString(database.Path));
        await first.OpenAsync(TestContext.Current.CancellationToken);
        await using var holding = CoreDatabase.BeginWrite(first);

        // One second, not zero: in ADO.NET a zero timeout means wait for ever. Unpooled, since its
        // own pool would keep the file open past the test's clean-up, which only empties the
        // core's pool for this file.
        await using var second = new SqliteConnection(
            new SqliteConnectionStringBuilder(CoreDatabase.ConnectionString(database.Path)) { DefaultTimeout = 1, Pooling = false }.ToString());
        await second.OpenAsync(TestContext.Current.CancellationToken);
        await using var attempt = second.CreateCommand();
        attempt.CommandText = "BEGIN IMMEDIATE";

        var busy = await Assert.ThrowsAsync<SqliteException>(() => attempt.ExecuteNonQueryAsync(TestContext.Current.CancellationToken));
        Assert.Equal(5, busy.SqliteErrorCode); // SQLITE_BUSY: the first transaction already holds the lock.
    }

    [Fact]
    public async Task The_database_files_are_readable_by_root_alone()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "Unix file modes");
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        await using var database = await TestDatabase.CreateAsync();

        foreach (var suffix in new[] { "", "-wal", "-shm" })
        {
            var file = database.Path + suffix;
            if (File.Exists(file))
            {
                Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(file));
            }
        }
    }
}
