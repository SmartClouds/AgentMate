using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Runova.ServerCore.Data;

namespace Runova.ServerCore.Tests;

/// <summary>A migrated core database in a temporary folder, removed again when the test ends.</summary>
public sealed class TestDatabase : IAsyncDisposable
{
    private TestDatabase(string directory)
    {
        Directory = directory;
        Path = CoreDatabase.PathIn(directory);
        Contexts = new PooledDbContextFactory<CoreDbContext>(CoreDatabase.Options(Path));
    }

    public string Directory { get; }

    public string Path { get; }

    internal IDbContextFactory<CoreDbContext> Contexts { get; }

    public static async Task<TestDatabase> CreateAsync()
    {
        var directory = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"core-db-{Guid.NewGuid():N}");
        System.IO.Directory.CreateDirectory(directory);
        var database = new TestDatabase(directory);
        await CoreDatabase.PrepareAsync(database.Path, CancellationToken.None);
        return database;
    }

    public ValueTask DisposeAsync()
    {
        TestFolders.Delete(Directory);
        return ValueTask.CompletedTask;
    }
}
