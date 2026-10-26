using System.Text;
using System.Text.Json;

namespace Runova.ServerCore.Registries;

/// <summary>A job needs registry sign-ins but there is nowhere safe to put them.</summary>
internal sealed class RegistryAuthUnavailableException(string message) : Exception(message);

/// <summary>
/// The per-job DOCKER_CONFIG folders. Each one holds a config.json with the job's sign-ins and
/// nothing else (no credential helpers, so the docker CLI never stores anything on its own), sits
/// under the core's runtime directory, which is tmpfs on a real server, and is wiped when the
/// job's work ends. On a server the core refuses to write sign-ins anywhere that is not a memory
/// filesystem, so a token never reaches a disk; the DevHost and the tests allow a plain folder.
/// </summary>
internal sealed partial class RegistryAuthFolders(
    string root,
    bool requireMemoryFilesystem,
    Func<string?> readMountTable,
    ILogger<RegistryAuthFolders> logger)
{
    public const string ConfigFileName = "config.json";

    private const UnixFileMode OwnerOnlyFolder = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute;

    private const UnixFileMode OwnerOnlyFile = UnixFileMode.UserRead | UnixFileMode.UserWrite;

    private static readonly HashSet<string> _memoryFilesystems = new(StringComparer.Ordinal) { "tmpfs", "ramfs" };

    public string Root { get; } = root;

    public bool RequireMemoryFilesystem { get; } = requireMemoryFilesystem;

    /// <summary>Writes the job's config.json. Dispose the lease to wipe it.</summary>
    public DockerConfigLease Create(Guid jobId, IReadOnlyList<RegistryLogin> logins)
    {
        ArgumentNullException.ThrowIfNull(logins);
        if (RequireMemoryFilesystem)
        {
            var filesystem = MountTable.FileSystemOf(Path.GetFullPath(Root), readMountTable());
            if (filesystem is null || !_memoryFilesystems.Contains(filesystem))
            {
                throw new RegistryAuthUnavailableException(
                    $"{Root} is not on a memory filesystem (it is on {filesystem ?? "an unknown filesystem"}), so the core will not write registry sign-ins there.");
            }
        }

        EnsurePrivate(Root);
        var directory = Path.Combine(Root, jobId.ToString("N"));
        if (Directory.Exists(directory))
        {
            Wipe(directory);
        }

        EnsurePrivate(directory);
        var lease = new DockerConfigLease(directory, this);
        try
        {
            var options = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write, Share = FileShare.None };
            if (!OperatingSystem.IsWindows())
            {
                options.UnixCreateMode = OwnerOnlyFile;
            }

            using var file = new FileStream(Path.Combine(directory, ConfigFileName), options);
            file.Write(Render(logins));
            file.Flush(flushToDisk: true);
        }
        catch
        {
            lease.Dispose();
            throw;
        }

        return lease;
    }

    /// <summary>Removes every job folder. At start-up nothing is running, so whatever is there was left behind.</summary>
    public int Sweep()
    {
        if (!Directory.Exists(Root))
        {
            return 0;
        }

        var count = 0;
        foreach (var directory in Directory.EnumerateDirectories(Root))
        {
            Wipe(directory);
            count++;
        }

        foreach (var file in Directory.EnumerateFiles(Root))
        {
            Overwrite(file);
            File.Delete(file);
        }

        return count;
    }

    /// <summary>config.json as the docker CLI reads it: base64 of user:secret per registry, and nothing else.</summary>
    internal static byte[] Render(IReadOnlyList<RegistryLogin> logins)
    {
        var auths = new Dictionary<string, Dictionary<string, string>>(StringComparer.Ordinal);
        foreach (var login in logins)
        {
            auths[RegistryNames.ConfigKey(login.Registry)] = new Dictionary<string, string>
            {
                ["auth"] = BasicAuth(login),
            };
        }

        return JsonSerializer.SerializeToUtf8Bytes(new Dictionary<string, object> { ["auths"] = auths });
    }

    /// <summary>What the docker CLI writes for a sign-in; the job's redactor masks this form too.</summary>
    public static string BasicAuth(RegistryLogin login)
    {
        ArgumentNullException.ThrowIfNull(login);
        return Convert.ToBase64String(Encoding.UTF8.GetBytes($"{login.Username}:{login.Secret}"));
    }

    internal void Wipe(string directory)
    {
        try
        {
            foreach (var file in Directory.EnumerateFiles(directory, "*", SearchOption.AllDirectories))
            {
                Overwrite(file);
            }

            Directory.Delete(directory, recursive: true);
        }
        catch (DirectoryNotFoundException)
        {
            // Already gone.
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            LogWipeFailed(logger, directory, error.GetType().Name);
            throw;
        }
    }

    /// <summary>Zeros first: a deleted tmpfs page goes back to the kernel, but nothing should be readable until then.</summary>
    private static void Overwrite(string path)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Write, FileShare.None);
        var zeros = new byte[Math.Min(stream.Length, 64 * 1024)];
        for (long written = 0; written < stream.Length; written += zeros.Length)
        {
            stream.Write(zeros, 0, (int)Math.Min(zeros.Length, stream.Length - written));
        }

        stream.Flush(flushToDisk: true);
    }

    private static void EnsurePrivate(string path)
    {
        if (OperatingSystem.IsWindows())
        {
            Directory.CreateDirectory(path);
            return;
        }

        Directory.CreateDirectory(path, OwnerOnlyFolder);
        if (File.GetUnixFileMode(path) != OwnerOnlyFolder)
        {
            File.SetUnixFileMode(path, OwnerOnlyFolder);
        }
    }

    [LoggerMessage(Level = LogLevel.Error, Message = "Could not wipe the registry sign-in folder {Folder} ({Error}). The next start-up sweeps it.")]
    private static partial void LogWipeFailed(ILogger logger, string folder, string error);
}

/// <summary>A job's DOCKER_CONFIG. Disposing it wipes the folder; call it from a finally.</summary>
internal sealed class DockerConfigLease(string directory, RegistryAuthFolders owner) : IDisposable
{
    private bool _disposed;

    public string Directory { get; } = directory;

    /// <summary>What a docker or docker compose call needs to use these sign-ins: the folder's path, never a secret.</summary>
    public IReadOnlyDictionary<string, string> Environment { get; } = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["DOCKER_CONFIG"] = directory,
    };

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        owner.Wipe(Directory);
    }
}

/// <summary>Reads /proc/self/mountinfo: which filesystem a path is on.</summary>
internal static class MountTable
{
    public const string Path = "/proc/self/mountinfo";

    /// <summary>The filesystem type of the longest mount point that contains the path, or null when unknown.</summary>
    public static string? FileSystemOf(string path, string? mountInfo)
    {
        ArgumentNullException.ThrowIfNull(path);
        if (string.IsNullOrEmpty(mountInfo))
        {
            return null;
        }

        string? best = null;
        var bestLength = -1;
        foreach (var line in mountInfo.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            // id parent major:minor root mount-point options [optional...] - type source super-options
            var fields = line.Split(' ');
            var separator = Array.IndexOf(fields, "-");
            if (fields.Length < 5 || separator < 0 || separator + 1 >= fields.Length)
            {
                continue;
            }

            var mountPoint = Unescape(fields[4]);
            if (Contains(mountPoint, path) && mountPoint.Length > bestLength)
            {
                best = fields[separator + 1];
                bestLength = mountPoint.Length;
            }
        }

        return best;
    }

    private static bool Contains(string mountPoint, string path) =>
        mountPoint == "/"
        || path == mountPoint
        || path.StartsWith(mountPoint + "/", StringComparison.Ordinal);

    /// <summary>mountinfo writes a space, tab, newline and backslash as octal escapes.</summary>
    private static string Unescape(string field) =>
        field.Replace("\\040", " ", StringComparison.Ordinal)
            .Replace("\\011", "\t", StringComparison.Ordinal)
            .Replace("\\012", "\n", StringComparison.Ordinal)
            .Replace("\\134", "\\", StringComparison.Ordinal);
}
