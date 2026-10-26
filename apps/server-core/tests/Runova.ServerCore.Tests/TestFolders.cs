using Runova.ServerCore.Data;

namespace Runova.ServerCore.Tests;

/// <summary>Temporary state folders for tests, removed again even when a database was open in them.</summary>
internal static class TestFolders
{
    public static string Create(string prefix) =>
        Path.Combine(Path.GetTempPath(), $"{prefix}-{Guid.NewGuid():N}");

    /// <summary>
    /// SQLite's connection pool keeps the database file open, which Windows will not delete, so the
    /// pools of the databases in the folder are emptied first. Only theirs: emptying every pool
    /// would reach into tests still running in parallel and can dispose a connection one of them
    /// is using (see <see cref="CoreDatabase.ReleasePool"/>). A few retries cover a handle that
    /// is still being let go.
    /// </summary>
    public static void Delete(string path)
    {
        if (Directory.Exists(path))
        {
            foreach (var database in Directory.EnumerateFiles(path, "*.db", SearchOption.AllDirectories))
            {
                CoreDatabase.ReleasePool(database);
            }
        }

        for (var attempt = 1; ; attempt++)
        {
            try
            {
                if (Directory.Exists(path))
                {
                    Directory.Delete(path, recursive: true);
                }

                return;
            }
            catch (IOException) when (attempt < 10)
            {
                Thread.Sleep(100);
            }
        }
    }
}
