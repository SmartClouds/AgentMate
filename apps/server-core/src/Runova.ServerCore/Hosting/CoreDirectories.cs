namespace Runova.ServerCore.Hosting;

/// <summary>
/// The state folder and the folders the core keeps inside it. Each is created as private as the
/// state folder itself (root only), whatever umask the process runs with.
/// </summary>
internal sealed class CoreDirectories(string dataDirectory)
{
    private const UnixFileMode OwnerOnly = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute;

    public string Data { get; } = dataDirectory;

    /// <summary>One log file per job.</summary>
    public string Jobs => Path.Combine(Data, "jobs");

    public string EnsureJobs() => EnsurePrivate(Jobs);

    /// <summary>One folder per compose stack, its revisions inside (E07).</summary>
    public string Stacks => Path.Combine(Data, "stacks");

    public string EnsureStacks() => EnsurePrivate(Stacks);

    private static string EnsurePrivate(string path)
    {
        if (OperatingSystem.IsWindows())
        {
            Directory.CreateDirectory(path);
            return path;
        }

        Directory.CreateDirectory(path, OwnerOnly);
        if (File.GetUnixFileMode(path) != OwnerOnly)
        {
            File.SetUnixFileMode(path, OwnerOnly);
        }

        return path;
    }
}
