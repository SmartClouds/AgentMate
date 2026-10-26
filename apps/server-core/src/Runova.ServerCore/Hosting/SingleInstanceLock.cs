namespace Runova.ServerCore.Hosting;

/// <summary>
/// An exclusive lock on a file in the state folder, held for as long as the core serves. Two cores
/// on the same state (an old unit started next to a migrated one, where the old state folder is
/// a link to the new) would each think the database and the firewall changes are theirs; the
/// second one stops before it binds anything instead.
/// </summary>
/// <remarks>
/// .NET takes FileShare.None on Unix as an advisory flock, so the lock goes with the process:
/// a core that crashes or is killed leaves nothing to clean up.
/// </remarks>
internal sealed class SingleInstanceLock : IDisposable
{
    public const string FileName = "core.lock";

    private readonly FileStream _file;

    private SingleInstanceLock(FileStream file) => _file = file;

    /// <summary>Takes the lock in <paramref name="dataDirectory"/>.</summary>
    /// <exception cref="InvalidOperationException">Another core holds it.</exception>
    public static SingleInstanceLock Acquire(string dataDirectory)
    {
        ArgumentException.ThrowIfNullOrEmpty(dataDirectory);
        Directory.CreateDirectory(dataDirectory);
        var path = Path.Combine(dataDirectory, FileName);
        var options = new FileStreamOptions
        {
            Mode = FileMode.OpenOrCreate,
            Access = FileAccess.ReadWrite,
            Share = FileShare.None,
        };
        if (!OperatingSystem.IsWindows())
        {
            options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        }

        try
        {
            return new SingleInstanceLock(new FileStream(path, options));
        }
        catch (IOException error)
        {
            throw new InvalidOperationException(
                $"Another server core is running on {dataDirectory} (it holds {path}), so this one stops.",
                error);
        }
    }

    public void Dispose() => _file.Dispose();
}

/// <summary>
/// The lock for the host that serves the socket, taken when Kestrel is about to bind it and let go
/// with the host. Loopback TCP (the DevHost) and the test server never take it.
/// </summary>
internal sealed class CoreInstance(IConfiguration configuration) : IDisposable
{
    private SingleInstanceLock? _lock;

    public void Hold() => _lock ??= SingleInstanceLock.Acquire(CorePaths.DataDirectory(configuration, OperatingSystem.IsLinux()));

    public void Dispose() => _lock?.Dispose();
}
