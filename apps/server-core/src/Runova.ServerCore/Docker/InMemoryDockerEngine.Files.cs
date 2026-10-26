using System.Collections.Concurrent;
using System.Globalization;
using System.Text;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Files;

namespace Runova.ServerCore.Docker;

/// <summary>A helper container the pretend engine runs, and the volume it serves.</summary>
internal sealed record InMemoryHelper(string Id, string Volume);

/// <summary>
/// Files in the pretend engine (E27): every container and volume has an in-memory file tree,
/// built the first time it is looked at, and an exec understands exactly the commands the files
/// service sends (its lister and stat scripts, readlink -f, mv, rm, rmdir and chmod), answering as
/// busybox would. The distroless container has no shell, so every exec finds nothing to run. A
/// volume is one folder node, shared by the containers that mount it and by its helper.
/// </summary>
internal sealed partial class InMemoryDockerEngine
{
    /// <summary>The seeded container whose image has no shell.</summary>
    public const string DistrolessContainer = "monitoring-cloudflared-1";

    private readonly SemaphoreSlim _filesGate = new(1, 1);
    private readonly Dictionary<string, MemoryDirectory> _containerRoots = new(StringComparer.Ordinal);
    private readonly Dictionary<string, MemoryDirectory> _volumeRoots = new(StringComparer.Ordinal);
    private readonly List<HelperContainer> _helpers = [];

    /// <summary>Each file operation, in order ("put shop-api-1 /srv a.txt 0:0", "exec shop-api-1 mv -f -- a b").</summary>
    public ConcurrentQueue<string> FileLog { get; } = new();

    /// <summary>When set, the helper image cannot be pulled and creating a helper fails with this engine message.</summary>
    public string? HelperPullError { get; set; }

    public void Dispose() => _filesGate.Dispose();

    public IReadOnlyList<InMemoryHelper> Helpers
    {
        get
        {
            lock (_gate)
            {
                return [.. _helpers.Select(h => new InMemoryHelper(h.Id, h.Spec.Volume))];
            }
        }
    }

    public async Task<ExecResult> RunExecAsync(string container, IReadOnlyList<string> command, string? user, TimeSpan timeout, int outputCapBytes, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        var target = Target(container);
        if (!target.Running)
        {
            throw new DockerRequestException($"container {target.Id} is not running");
        }

        FileLog.Enqueue($"exec {target.Name} {Describe(command)}");
        if (!target.Shell)
        {
            return new ExecResult(127, Encoding.UTF8.GetBytes($"OCI runtime exec failed: exec failed: unable to start container process: exec: \"{command[0]}\": executable file not found in $PATH"), [], false);
        }

        await _filesGate.WaitAsync(cancellationToken);
        try
        {
            var (code, stdout, stderr) = Run(target.Root, command);
            var truncated = stdout.Length > outputCapBytes;
            return new ExecResult(truncated ? null : code, truncated ? stdout[..outputCapBytes] : stdout, Encoding.UTF8.GetBytes(stderr), truncated);
        }
        finally
        {
            _filesGate.Release();
        }
    }

    public async Task<PathStat?> StatPathAsync(string container, string path, CancellationToken cancellationToken)
    {
        var target = Target(container);
        await _filesGate.WaitAsync(cancellationToken);
        try
        {
            var found = InMemoryFileTree.TryResolve(target.Root, path, followLast: path.EndsWith("/.", StringComparison.Ordinal));
            return found?.Node is { } node
                ? new PathStat(found.Name.Length == 0 ? "/" : found.Name, node.Size, node.Mode, node.MtimeMs - (node.MtimeMs % 1000), (node as MemorySymlink)?.Target)
                : null;
        }
        finally
        {
            _filesGate.Release();
        }
    }

    public async Task<Stream> GetArchiveAsync(string container, string path, CancellationToken cancellationToken)
    {
        var target = Target(container);
        await _filesGate.WaitAsync(cancellationToken);
        try
        {
            return InMemoryFileTree.Archive(target.Root, path);
        }
        catch (MemoryFsException)
        {
            throw new DockerPathNotFoundException($"Could not find the file {path} in container {target.Name}");
        }
        finally
        {
            _filesGate.Release();
        }
    }

    public async Task PutArchiveAsync(string container, string folder, Stream archive, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(archive);
        var target = Target(container);
        await _filesGate.WaitAsync(cancellationToken);
        try
        {
            var found = InMemoryFileTree.TryResolve(target.Root, folder, followLast: true);
            if (found?.Node is null)
            {
                throw new DockerPathNotFoundException($"Could not find the file {folder} in container {target.Name}");
            }

            if (found.Node is not MemoryDirectory destination)
            {
                throw new DockerRequestException("extraction point is not a directory");
            }

            await InMemoryFileTree.ExtractAsync(
                destination,
                archive,
                NowMs,
                (name, node) => FileLog.Enqueue($"put {target.Name} {folder} {name.TrimEnd('/')} {node.Uid}:{node.Gid}"),
                cancellationToken);
        }
        finally
        {
            _filesGate.Release();
        }
    }

    public Task<string> CreateHelperAsync(HelperSpec spec, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(spec);
        EnsureRunning();
        if (HelperPullError is { } error)
        {
            throw new DockerRequestException($"Docker could not download {spec.Image}: {error}");
        }

        lock (_gate)
        {
            if (_volumes.All(v => v.Name != spec.Volume))
            {
                // As Docker does: mounting a named volume that is not there creates it.
                _volumes.Add(new VolumeEntry(spec.Volume, NowMs, 0, null, Anonymous: false));
            }

            var id = IdOf($"helper:{spec.Volume}:{Guid.NewGuid():N}");
            var root = BusyboxRoot();
            root.Children[spec.MountPoint.Trim('/')] = VolumeRoot(spec.Volume);
            _helpers.Add(new HelperContainer(id, $"runova-files-{id[..12]}", spec, root));
            FileLog.Enqueue($"helper-create {spec.Volume} {id}");
            return Task.FromResult(id);
        }
    }

    public Task RemoveHelperAsync(string helper, CancellationToken cancellationToken)
    {
        EnsureRunning();
        lock (_gate)
        {
            foreach (var found in _helpers.Where(h => h.Id == helper || h.Name == helper).ToList())
            {
                _helpers.Remove(found);
                FileLog.Enqueue($"helper-remove {found.Spec.Volume} {found.Id}");
            }
        }

        return Task.CompletedTask;
    }

    public Task<IReadOnlyList<string>> ListLabelledContainersAsync(string label, CancellationToken cancellationToken)
    {
        EnsureRunning();
        lock (_gate)
        {
            return Task.FromResult<IReadOnlyList<string>>(
            [
                .. _helpers.Where(h => h.Spec.Labels.ContainsKey(label)).Select(h => h.Id),
                .. _containers.Where(c => c.Labels.Any(entry => entry.Key == label)).Select(c => c.Id),
            ]);
        }
    }

    /// <summary>
    /// Puts an entry into a volume's or a container's tree, folders on the way made as needed
    /// (the DevHost's /dev/files/seed and the tests).
    /// </summary>
    public void PlantEntry(FileTargetKind kind, string id, string path, char type, int? mode = null, byte[]? content = null, long? mtimeUnixMs = null, string? linkTarget = null)
    {
        ArgumentNullException.ThrowIfNull(path);
        _filesGate.Wait();
        try
        {
            MemoryDirectory root;
            lock (_gate)
            {
                root = kind == FileTargetKind.Volume
                    ? _volumes.Any(v => v.Name == id) ? VolumeRoot(id) : throw new DockerNotFoundException($"get {id}: no such volume")
                    : Target(id).Root;
            }

            var normalized = FilePaths.Normalize(path);
            var parent = InMemoryFileTree.Folder(root, FilePaths.Parent(normalized), 0x1ED, 0, 0, NowMs);
            MemoryNode node = type switch
            {
                'd' => parent.Children.TryGetValue(FilePaths.Name(normalized), out var existing) && existing is MemoryDirectory folder ? folder : new MemoryDirectory { Permissions = 0x1ED },
                'l' => new MemorySymlink(linkTarget ?? throw new ArgumentException("A link needs a target.", nameof(linkTarget))) { Permissions = 0x1FF },
                _ => new MemoryFile { Content = content ?? [] },
            };
            node.Permissions = mode ?? node.Permissions;
            node.MtimeMs = mtimeUnixMs ?? NowMs;
            parent.Children[FilePaths.Name(normalized)] = node;
        }
        finally
        {
            _filesGate.Release();
        }
    }

    public void PlantLink(string volume, string path, string target) => PlantEntry(FileTargetKind.Volume, volume, path, 'l', linkTarget: target);

    private static string Describe(IReadOnlyList<string> command) =>
        command is ["sh", "-c", var script, ..]
            ? "sh " + (script == FileScripts.List ? "list" : script == FileScripts.Stat ? "stat" : script == FileScripts.Probe ? "probe" : script == FileScripts.Real ? "real" : "script") + (command.Count > 4 ? " " + string.Join(' ', command.Skip(4)) : string.Empty)
            : string.Join(' ', command);

    /// <summary>A container or a helper, by id, name or id prefix, with its tree.</summary>
    private ExecTarget Target(string reference)
    {
        EnsureRunning();
        lock (_gate)
        {
            if (_helpers.FirstOrDefault(h => h.Id == reference || h.Name == reference || (reference.Length >= 12 && h.Id.StartsWith(reference, StringComparison.Ordinal))) is { } helper)
            {
                return new ExecTarget(helper.Id, helper.Name, helper.Root, Running: true, Shell: true);
            }

            var found = Find(reference);
            if (!_containerRoots.TryGetValue(found.Id, out var root))
            {
                root = ContainerRoot(found);
                _containerRoots[found.Id] = root;
            }

            return new ExecTarget(found.Id, found.Name, root, found.State == ContainerState.Running, found.Shell);
        }
    }

    private MemoryDirectory VolumeRoot(string volume)
    {
        if (!_volumeRoots.TryGetValue(volume, out var root))
        {
            root = SeedVolume(volume);
            _volumeRoots[volume] = root;
        }

        return root;
    }

    private static (int Code, byte[] Stdout, string Stderr) Run(MemoryDirectory root, IReadOnlyList<string> command)
    {
        switch (command)
        {
            case ["sh", "-c", FileScripts.Probe]:
                return (0, "ok\n"u8.ToArray(), string.Empty);
            case ["sh", "-c", FileScripts.List, "sh", var folder, var limit]:
                return Lister(root, folder, limit, null);
            case ["sh", "-c", FileScripts.Stat, "sh", var folder, var limit, var name]:
                return Lister(root, folder, limit, name);
            case ["sh", "-c", FileScripts.Real, "sh", var limit, var path]:
                try
                {
                    return (0, Encoding.UTF8.GetBytes(InMemoryFileTree.Resolve(root, path, followLast: true, limit).Canonical), string.Empty);
                }
                catch (MemoryFsException error)
                {
                    return (error.Message switch
                    {
                        InMemoryFileTree.NotADirectory => FileScripts.NotDirectoryExit,
                        InMemoryFileTree.TooManyLinks => FileScripts.LoopExit,
                        _ => FileScripts.NotFoundExit,
                    }, [], string.Empty);
                }

            case ["readlink", "-f", "--", var path]:
                try
                {
                    return (0, Encoding.UTF8.GetBytes(InMemoryFileTree.Resolve(root, path, followLast: true).Canonical + "\n"), string.Empty);
                }
                catch (MemoryFsException)
                {
                    return (1, [], string.Empty);
                }

            case ["mv", "-f", "--", var from, var to]:
                return Fail(() => Move(root, from, to), $"mv: can't rename '{from}'");
            case ["rm", "-f", "--", var path]:
                return Fail(() => RemoveFile(root, path), $"rm: can't remove '{path}'");
            case ["rmdir", "--", var path]:
                return Fail(() => RemoveFolder(root, path), $"rmdir: '{path}'");
            case ["chmod", var mode, "--", var path]:
                return Fail(() => Chmod(root, path, mode), $"chmod: {path}");
            default:
                return (127, Encoding.UTF8.GetBytes($"OCI runtime exec failed: exec failed: unable to start container process: exec: \"{command[0]}\": executable file not found in $PATH"), string.Empty);
        }
    }

    private static (int Code, byte[] Stdout, string Stderr) Fail(Action action, string prefix)
    {
        try
        {
            action();
            return (0, [], string.Empty);
        }
        catch (MemoryFsException error)
        {
            return (1, [], $"{prefix}: {error.Message}\n");
        }
    }

    /// <summary>What the List and Stat scripts print, exit codes included.</summary>
    private static (int Code, byte[] Stdout, string Stderr) Lister(MemoryDirectory root, string folder, string limit, string? single)
    {
        var found = InMemoryFileTree.TryResolve(root, folder, followLast: true, limit);
        if (found?.Node is null)
        {
            return (FileScripts.NotFoundExit, [], string.Empty);
        }

        if (found.Node is not MemoryDirectory directory)
        {
            return (FileScripts.NotDirectoryExit, [], string.Empty);
        }

        if (limit.Length > 0 && found.Canonical != limit && !found.Canonical.StartsWith(limit + "/", StringComparison.Ordinal))
        {
            return (FileScripts.OutsideExit, [], string.Empty);
        }

        var output = new List<byte>();
        if (single is not null)
        {
            var node = single == "." ? directory : directory.Children.GetValueOrDefault(single);
            if (node is null)
            {
                return (FileScripts.NotFoundExit, [], string.Empty);
            }

            Record(root, found.Canonical, single, node, limit, output);
            return (0, [.. output], string.Empty);
        }

        var ordered = directory.Children
            .OrderBy(c => c.Key.StartsWith("..", StringComparison.Ordinal) ? 2 : c.Key.StartsWith('.') ? 1 : 0)
            .ThenBy(c => c.Key, StringComparer.Ordinal);
        foreach (var (name, node) in ordered)
        {
            Record(root, found.Canonical, name, node, limit, output);
        }

        return (0, [.. output], string.Empty);
    }

    private static void Record(MemoryDirectory root, string folder, string name, MemoryNode node, string limit, List<byte> output)
    {
        output.AddRange(Encoding.ASCII.GetBytes(string.Create(
            CultureInfo.InvariantCulture,
            $"{node.Size} {node.Mode:x} {(node.MtimeMs - (node.MtimeMs % 1000)) / 1000} {(uint)node.Uid} {(uint)node.Gid}\n")));
        if (node is MemorySymlink link)
        {
            var target = InMemoryFileTree.TryResolve(root, FilePaths.Combine(folder, name), followLast: true, limit)?.Node;
            output.Add(target is MemoryDirectory ? (byte)'d' : target is null ? (byte)'b' : (byte)'f');
            output.Add((byte)'\n');
            output.AddRange(Encoding.UTF8.GetBytes(link.Target));
            output.Add(0);
        }

        output.AddRange(Encoding.UTF8.GetBytes(name));
        output.Add(0);
    }

    private static void Move(MemoryDirectory root, string from, string to)
    {
        var source = InMemoryFileTree.Resolve(root, from, followLast: false);
        var moving = source.Node ?? throw new MemoryFsException(InMemoryFileTree.NoSuchFile);
        var into = InMemoryFileTree.TryResolve(root, to, followLast: true);
        var (folder, name) = into?.Node is MemoryDirectory directory && !ReferenceEquals(directory, moving)
            ? (directory, source.Name)
            : InMemoryFileTree.Resolve(root, to, followLast: false) is var destination ? (destination.Parent, destination.Name) : default;
        if (folder.Children.TryGetValue(name, out var existing) && !ReferenceEquals(existing, moving))
        {
            if (existing is MemoryDirectory taken)
            {
                if (moving is not MemoryDirectory)
                {
                    throw new MemoryFsException("Is a directory");
                }

                if (taken.Children.Count > 0)
                {
                    throw new MemoryFsException("Directory not empty");
                }
            }
            else if (moving is MemoryDirectory)
            {
                throw new MemoryFsException(InMemoryFileTree.NotADirectory);
            }
        }

        if (moving is MemoryDirectory movingFolder && Contains(movingFolder, folder))
        {
            throw new MemoryFsException("Invalid argument");
        }

        source.Parent.Children.Remove(source.Name);
        folder.Children[name] = moving;
    }

    private static bool Contains(MemoryDirectory outer, MemoryDirectory inner) =>
        ReferenceEquals(outer, inner) || outer.Children.Values.OfType<MemoryDirectory>().Any(child => Contains(child, inner));

    private static void RemoveFile(MemoryDirectory root, string path)
    {
        var found = InMemoryFileTree.TryResolve(root, path, followLast: false);
        if (found?.Node is null)
        {
            return;
        }

        if (found.Node is MemoryDirectory)
        {
            throw new MemoryFsException("is a directory");
        }

        found.Parent.Children.Remove(found.Name);
    }

    private static void RemoveFolder(MemoryDirectory root, string path)
    {
        var found = InMemoryFileTree.Resolve(root, path, followLast: false);
        switch (found.Node)
        {
            case null:
                throw new MemoryFsException(InMemoryFileTree.NoSuchFile);
            case not MemoryDirectory:
                throw new MemoryFsException(InMemoryFileTree.NotADirectory);
            case MemoryDirectory { Children.Count: > 0 }:
                throw new MemoryFsException("Directory not empty");
            default:
                if (found.Canonical == "/" || found.Parent.Children.GetValueOrDefault(found.Name) is null)
                {
                    throw new MemoryFsException("Device or resource busy");
                }

                found.Parent.Children.Remove(found.Name);
                break;
        }
    }

    private static void Chmod(MemoryDirectory root, string path, string mode)
    {
        var found = InMemoryFileTree.Resolve(root, path, followLast: true);
        (found.Node ?? throw new MemoryFsException(InMemoryFileTree.NoSuchFile)).Permissions = Convert.ToInt32(mode, 8) & 0xFFF;
    }

    private sealed record ExecTarget(string Id, string Name, MemoryDirectory Root, bool Running, bool Shell);

    private sealed record HelperContainer(string Id, string Name, HelperSpec Spec, MemoryDirectory Root);
}
