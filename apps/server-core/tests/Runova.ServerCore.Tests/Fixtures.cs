namespace Runova.ServerCore.Tests;

/// <summary>
/// Files captured from real servers (or written to match them where no image was at hand) under
/// Fixtures/: os-release files, /proc and command output from both OS families.
/// </summary>
internal static class Fixtures
{
    public static string PathOf(string relative) =>
        Path.Combine(AppContext.BaseDirectory, "Fixtures", relative.Replace('/', Path.DirectorySeparatorChar));

    public static string Read(string relative) => File.ReadAllText(PathOf(relative));

    /// <summary>A directory laid out like a server's root: etc/, proc/, run/.</summary>
    public static string Host(string name) => PathOf($"hosts/{name}");
}
