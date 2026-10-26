using System.Runtime.InteropServices;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Jobs;

namespace Runova.ServerCore.Nginx;

/// <summary>
/// The machine nginx runs on, as the web module needs it: files under absolute paths, symlinks,
/// and programs. Everything about nginx itself (releases, apply, reload checks, SELinux) is built
/// on top of this, so it runs the same against the real server, a container in the system tests,
/// or the simulation the DevHost and the unit tests use.
/// </summary>
internal interface INginxMachine
{
    /// <summary>The file's text, or null when it does not exist.</summary>
    Task<string?> ReadTextAsync(string path, CancellationToken cancellationToken);

    /// <summary>Replaces the file in one step, creating missing parent folders (0755).</summary>
    Task WriteAsync(string path, ReadOnlyMemory<byte> content, UnixFileMode mode, CancellationToken cancellationToken);

    Task<bool> ExistsAsync(string path, CancellationToken cancellationToken);

    /// <summary>A file, link or folder (with everything in it). Nothing happens when it is not there.</summary>
    Task DeleteAsync(string path, CancellationToken cancellationToken);

    /// <summary>Creates the folder and its missing parents (0755, whatever the umask); the folder itself gets the mode.</summary>
    Task CreateDirectoryAsync(string path, UnixFileMode mode, CancellationToken cancellationToken);

    /// <summary>The names in a folder, or nothing when it does not exist.</summary>
    Task<IReadOnlyList<string>> ListAsync(string path, CancellationToken cancellationToken);

    /// <summary>Where a symlink points, as written, or null when the path is not a link.</summary>
    Task<string?> ReadLinkAsync(string path, CancellationToken cancellationToken);

    /// <summary>Points the link at the target in one step (a new link renamed over the old one).</summary>
    Task ReplaceLinkAsync(string path, string target, CancellationToken cancellationToken);

    /// <summary>
    /// Renames a file, link or folder within its file system (rename(2)): in one step, with
    /// everything in it, and refused when the target is there already.
    /// </summary>
    Task MoveAsync(string from, string to, CancellationToken cancellationToken);

    /// <summary>The file's size in bytes, or null when it does not exist.</summary>
    Task<long?> LengthAsync(string path, CancellationToken cancellationToken);

    /// <summary>Up to maxBytes from the offset on.</summary>
    Task<byte[]> ReadRangeAsync(string path, long offset, int maxBytes, CancellationToken cancellationToken);

    /// <summary>A quick command (nginx -t, a reload signal, a status check).</summary>
    Task<ProcessResult> RunAsync(ProcessSpec spec, CancellationToken cancellationToken);

    /// <summary>Privileged work for a job (packages, SELinux policy), in a transient unit, its output in the job's log.</summary>
    Task<ProcessResult> RunInUnitAsync(JobContext job, string step, string description, ProcessSpec spec, CancellationToken cancellationToken);
}

/// <summary>The server the core runs on. Paths may be rooted elsewhere for tests on Linux.</summary>
internal sealed partial class LocalNginxMachine(IProcessRunner runner, SystemdRunner units, string root = "/") : INginxMachine
{
    private const UnixFileMode Folder =
        UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
        | UnixFileMode.GroupRead | UnixFileMode.GroupExecute | UnixFileMode.OtherRead | UnixFileMode.OtherExecute;

    public async Task<string?> ReadTextAsync(string path, CancellationToken cancellationToken)
    {
        try
        {
            return await File.ReadAllTextAsync(Map(path), cancellationToken);
        }
        catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException)
        {
            return null;
        }
    }

    public async Task WriteAsync(string path, ReadOnlyMemory<byte> content, UnixFileMode mode, CancellationToken cancellationToken)
    {
        var target = Map(path);
        EnsureDirectory(Path.GetDirectoryName(target)!, Folder);
        var temporary = $"{target}.runova-{Guid.NewGuid():N}";
        var options = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write };
        if (!OperatingSystem.IsWindows())
        {
            // Created with its final mode, so a private key is never readable by others, not even briefly.
            options.UnixCreateMode = mode;
        }

        try
        {
            await using (var stream = new FileStream(temporary, options))
            {
                await stream.WriteAsync(content, cancellationToken);
                await stream.FlushAsync(cancellationToken);
            }

            if (!OperatingSystem.IsWindows())
            {
                File.SetUnixFileMode(temporary, mode);
            }

            File.Move(temporary, target, overwrite: true);
        }
        catch
        {
            File.Delete(temporary);
            throw;
        }
    }

    public Task<bool> ExistsAsync(string path, CancellationToken cancellationToken)
    {
        var mapped = Map(path);
        return Task.FromResult(File.Exists(mapped) || Directory.Exists(mapped) || new FileInfo(mapped).LinkTarget is not null);
    }

    public Task DeleteAsync(string path, CancellationToken cancellationToken)
    {
        var mapped = Map(path);
        var info = new FileInfo(mapped);
        if (info.LinkTarget is not null || File.Exists(mapped))
        {
            File.Delete(mapped);
        }
        else if (Directory.Exists(mapped))
        {
            Directory.Delete(mapped, recursive: true);
        }

        return Task.CompletedTask;
    }

    public Task CreateDirectoryAsync(string path, UnixFileMode mode, CancellationToken cancellationToken)
    {
        EnsureDirectory(Map(path), mode);
        return Task.CompletedTask;
    }

    public Task<IReadOnlyList<string>> ListAsync(string path, CancellationToken cancellationToken)
    {
        var mapped = Map(path);
        IReadOnlyList<string> names = Directory.Exists(mapped)
            ? [.. Directory.EnumerateFileSystemEntries(mapped).Select(entry => Path.GetFileName(entry))]
            : [];
        return Task.FromResult(names);
    }

    public Task<string?> ReadLinkAsync(string path, CancellationToken cancellationToken) =>
        Task.FromResult(new FileInfo(Map(path)).LinkTarget);

    public Task ReplaceLinkAsync(string path, string target, CancellationToken cancellationToken)
    {
        var mapped = Map(path);
        var temporary = $"{mapped}.runova-{Guid.NewGuid():N}";
        File.CreateSymbolicLink(temporary, target);
        // rename(2) replaces the old link itself, never what it points at, and does it atomically:
        // nginx sees the old release or the new one, never a missing link.
        if (OperatingSystem.IsWindows())
        {
            File.Delete(mapped);
            File.Move(temporary, mapped);
        }
        else if (Rename(temporary, mapped) != 0)
        {
            var errno = Marshal.GetLastPInvokeError();
            File.Delete(temporary);
            throw new IOException($"Could not point {path} at {target} (errno {errno}).");
        }

        return Task.CompletedTask;
    }

    public Task MoveAsync(string from, string to, CancellationToken cancellationToken)
    {
        var source = Map(from);
        var target = Map(to);
        if (File.Exists(target) || Directory.Exists(target) || new FileInfo(target).LinkTarget is not null)
        {
            throw new IOException($"Could not move {from}: {to} is there already.");
        }

        if (Directory.Exists(source) && new FileInfo(source).LinkTarget is null)
        {
            Directory.Move(source, target);
        }
        else
        {
            File.Move(source, target);
        }

        return Task.CompletedTask;
    }

    public Task<long?> LengthAsync(string path, CancellationToken cancellationToken)
    {
        var info = new FileInfo(Map(path));
        return Task.FromResult(info.Exists ? info.Length : (long?)null);
    }

    public async Task<byte[]> ReadRangeAsync(string path, long offset, int maxBytes, CancellationToken cancellationToken)
    {
        await using var stream = new FileStream(Map(path), FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        if (offset >= stream.Length)
        {
            return [];
        }

        stream.Position = offset;
        var buffer = new byte[(int)Math.Min(maxBytes, stream.Length - offset)];
        var read = await stream.ReadAtLeastAsync(buffer, buffer.Length, throwOnEndOfStream: false, cancellationToken);
        return buffer[..read];
    }

    public Task<ProcessResult> RunAsync(ProcessSpec spec, CancellationToken cancellationToken) =>
        runner.RunAsync(spec, onLine: null, cancellationToken);

    public Task<ProcessResult> RunInUnitAsync(JobContext job, string step, string description, ProcessSpec spec, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(job);
        return units.RunAsync(job.UnitFor(step), description, spec, job.Output, cancellationToken);
    }

    private static void EnsureDirectory(string path, UnixFileMode mode)
    {
        if (OperatingSystem.IsWindows())
        {
            Directory.CreateDirectory(path);
            return;
        }

        // Each missing folder is made on its own and given its mode outright: the service's
        // UMask=0077 would leave new parents at 0700, and nginx's workers could then not reach the
        // ACME webroot or a site's files inside them.
        var missing = new Stack<string>();
        for (var folder = path; !string.IsNullOrEmpty(folder) && !Directory.Exists(folder); folder = Path.GetDirectoryName(folder))
        {
            missing.Push(folder);
        }

        while (missing.TryPop(out var folder))
        {
            var folderMode = missing.Count == 0 ? mode : Folder;
            Directory.CreateDirectory(folder, folderMode);
            File.SetUnixFileMode(folder, folderMode);
        }
    }

    private string Map(string path)
    {
        ArgumentNullException.ThrowIfNull(path);
        if (!path.StartsWith('/') || path.Split('/').Any(part => part is "." or ".."))
        {
            throw new ArgumentException("Paths on the server are absolute, without . or .. parts.", nameof(path));
        }

        return root == "/" ? path : Path.Combine(root, path[1..].Replace('/', Path.DirectorySeparatorChar));
    }

    [LibraryImport("libc", EntryPoint = "rename", SetLastError = true, StringMarshalling = StringMarshalling.Utf8)]
    private static partial int Rename(string from, string to);
}
