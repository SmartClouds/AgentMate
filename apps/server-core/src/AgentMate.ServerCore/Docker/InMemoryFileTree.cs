using System.Formats.Tar;
using System.Text;
using AgentMate.ServerCore.Uploads;

namespace AgentMate.ServerCore.Docker;

/// <summary>A file, folder or link in a pretend container: permission bits, owner and time.</summary>
internal abstract class MemoryNode
{
    public int Permissions { get; set; } = 0x1A4;

    public int Uid { get; set; }

    public int Gid { get; set; }

    public long MtimeMs { get; set; }

    public abstract int TypeBits { get; }

    public int Mode => TypeBits | (Permissions & 0xFFF);

    public abstract long Size { get; }
}

internal sealed class MemoryDirectory : MemoryNode
{
    public SortedDictionary<string, MemoryNode> Children { get; } = new(StringComparer.Ordinal);

    public override int TypeBits => 0x4000;

    public override long Size => 4096;
}

internal sealed class MemoryFile : MemoryNode
{
    public byte[] Content { get; set; } = [];

    public override int TypeBits => 0x8000;

    public override long Size => Content.Length;
}

internal sealed class MemorySymlink(string target) : MemoryNode
{
    public string Target { get; } = target;

    public override int TypeBits => 0xA000;

    public override long Size => Encoding.UTF8.GetByteCount(Target);
}

/// <summary>What a system call would have answered: the errno's words, as the tools print them.</summary>
internal sealed class MemoryFsException(string error) : Exception(error);

/// <param name="Node">What is at the path, or null when only its last name is missing.</param>
/// <param name="Parent">The folder the last name is in.</param>
/// <param name="Canonical">The path with every link and dot resolved.</param>
internal sealed record MemoryLookup(MemoryNode? Node, MemoryDirectory Parent, string Name, string Canonical);

/// <summary>
/// Path walking, tars and extraction over one pretend root file system. Links resolve the way the
/// kernel resolves them: absolute ones from the root, relative ones from their folder, at most 40
/// of them in one walk. A volume is a folder node shared by every tree that mounts it.
/// </summary>
internal static class InMemoryFileTree
{
    public const string NoSuchFile = "No such file or directory";
    public const string NotADirectory = "Not a directory";
    public const string TooManyLinks = "Too many levels of symbolic links";

    /// <param name="jail">
    /// A folder that absolute link targets start from and ".." stops at, as the files service's
    /// resolver treats a volume's mount point; empty for the kernel's own rules.
    /// </param>
    public static MemoryLookup Resolve(MemoryDirectory root, string path, bool followLast, string jail = "")
    {
        var pending = new Stack<string>(path.Split('/').Reverse());
        var jailChain = new List<(string Name, MemoryDirectory Folder)>();
        var jailFolder = root;
        foreach (var part in jail.Split('/', StringSplitOptions.RemoveEmptyEntries))
        {
            jailFolder = jailFolder.Children.GetValueOrDefault(part) as MemoryDirectory ?? throw new MemoryFsException(NoSuchFile);
            jailChain.Add((part, jailFolder));
        }

        var chain = new List<(string Name, MemoryDirectory Folder)>();
        var current = root;
        var hops = 0;
        while (pending.Count > 0)
        {
            var part = pending.Pop();
            if (part is "" or ".")
            {
                continue;
            }

            if (part == "..")
            {
                if (chain.Count > jailChain.Count)
                {
                    chain.RemoveAt(chain.Count - 1);
                }

                current = chain.Count > 0 ? chain[^1].Folder : root;
                continue;
            }

            var last = !pending.Any(rest => rest is not ("" or "."));
            if (!current.Children.TryGetValue(part, out var node))
            {
                return last ? new MemoryLookup(null, current, part, Canonical(chain, part)) : throw new MemoryFsException(NoSuchFile);
            }

            if (node is MemorySymlink link && (!last || followLast))
            {
                if (++hops > 40)
                {
                    throw new MemoryFsException(TooManyLinks);
                }

                foreach (var segment in link.Target.Split('/').Reverse())
                {
                    pending.Push(segment);
                }

                if (link.Target.StartsWith('/'))
                {
                    chain = [.. jailChain];
                    current = jailFolder;
                }

                continue;
            }

            if (last && pending.Count == 0)
            {
                return new MemoryLookup(node, current, part, Canonical(chain, part));
            }

            if (node is not MemoryDirectory folder)
            {
                throw new MemoryFsException(NotADirectory);
            }

            chain.Add((part, folder));
            current = folder;
        }

        // The path names a folder itself ("/", or one ending in "." or "..").
        var parent = chain.Count > 1 ? chain[^2].Folder : root;
        return new MemoryLookup(current, parent, chain.Count > 0 ? chain[^1].Name : string.Empty, "/" + string.Join('/', chain.Select(c => c.Name)));
    }

    /// <summary>What a lookup finds, or null when anything on the way is missing, not a folder, or loops.</summary>
    public static MemoryLookup? TryResolve(MemoryDirectory root, string path, bool followLast, string jail = "")
    {
        try
        {
            return Resolve(root, path, followLast, jail);
        }
        catch (MemoryFsException)
        {
            return null;
        }
    }

    public static MemoryDirectory Folder(MemoryDirectory root, string path, int permissions, int uid, int gid, long mtimeMs)
    {
        var current = root;
        foreach (var part in path.Split('/', StringSplitOptions.RemoveEmptyEntries))
        {
            if (!current.Children.TryGetValue(part, out var node))
            {
                node = new MemoryDirectory { Permissions = permissions, Uid = uid, Gid = gid, MtimeMs = mtimeMs };
                current.Children[part] = node;
            }

            current = node as MemoryDirectory ?? throw new MemoryFsException(NotADirectory);
        }

        return current;
    }

    /// <summary>
    /// The archive API's tar of a path: the entry itself (a folder with everything in it), named
    /// by its last name, or "." with "./" names when the path ends in "/.".
    /// </summary>
    public static MemoryStream Archive(MemoryDirectory root, string path)
    {
        var contents = path.EndsWith("/.", StringComparison.Ordinal) || path == ".";
        var found = Resolve(root, contents ? path : path.TrimEnd('/'), followLast: contents);
        if (found.Node is null)
        {
            throw new MemoryFsException(NoSuchFile);
        }

        var archive = new MemoryStream();
        using (var writer = new TarWriter(archive, TarEntryFormat.Pax, leaveOpen: true))
        {
            Write(writer, contents ? "." : found.Name.Length == 0 ? "/" : found.Name, found.Node);
        }

        archive.Position = 0;
        return archive;
    }

    /// <summary>Extracts a tar into a folder. A file is created first and filled as its bytes arrive, as Docker does it.</summary>
    public static async Task ExtractAsync(MemoryDirectory folder, Stream archive, long nowMs, Action<string, MemoryNode> written, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(written);
        var reader = new TarStreamReader(archive);
        var buffer = new byte[64 * 1024];
        while (await reader.ReadNextAsync(cancellationToken) is { } header)
        {
            if (header.Type is 'g' or 'x')
            {
                continue;
            }

            var parts = header.Name.Split('/', StringSplitOptions.RemoveEmptyEntries).Where(part => part != ".").ToArray();
            if (parts.Length == 0)
            {
                continue;
            }

            if (parts.Contains("..") || header.Name.StartsWith('/'))
            {
                throw new DockerRequestException($"invalid archive entry {header.Name}");
            }

            var parent = parts.Length == 1 ? folder : Folder(folder, string.Join('/', parts[..^1]), 0x1ED, 0, 0, nowMs);
            var name = parts[^1];
            parent.Children.TryGetValue(name, out var existing);
            var mtime = header.MtimeUnixMs != 0 ? header.MtimeUnixMs : nowMs;
            MemoryNode node;
            switch (header.Type)
            {
                case '5':
                    if (existing is not null and not MemoryDirectory)
                    {
                        throw new DockerRequestException($"cannot overwrite non-directory {name} with directory");
                    }

                    node = existing ?? new MemoryDirectory();
                    break;
                case '2':
                    node = new MemorySymlink(header.LinkName);
                    break;
                case '0' or '7':
                    if (existing is MemoryDirectory)
                    {
                        throw new DockerRequestException($"cannot overwrite directory {name} with non-directory");
                    }

                    node = new MemoryFile();
                    break;
                default:
                    continue;
            }

            node.Permissions = header.Mode & 0xFFF;
            node.Uid = header.Uid;
            node.Gid = header.Gid;
            node.MtimeMs = mtime;
            parent.Children[name] = node;
            written(header.Name, node);
            if (node is MemoryFile file)
            {
                using var content = new MemoryStream();
                try
                {
                    int read;
                    while ((read = await reader.ReadContentAsync(buffer, cancellationToken)) > 0)
                    {
                        content.Write(buffer, 0, read);
                    }
                }
                finally
                {
                    file.Content = content.ToArray();
                }
            }
        }
    }

    private static void Write(TarWriter writer, string name, MemoryNode node)
    {
        var entry = node switch
        {
            MemoryDirectory => new PaxTarEntry(TarEntryType.Directory, name == "/" ? "/" : name + "/"),
            MemorySymlink link => new PaxTarEntry(TarEntryType.SymbolicLink, name) { LinkName = link.Target },
            MemoryFile file => new PaxTarEntry(TarEntryType.RegularFile, name) { DataStream = new MemoryStream(file.Content) },
            _ => throw new InvalidOperationException("Unknown node."),
        };
        entry.Mode = (UnixFileMode)(node.Permissions & 0xFFF);
        entry.Uid = node.Uid;
        entry.Gid = node.Gid;
        entry.ModificationTime = DateTimeOffset.FromUnixTimeMilliseconds(node.MtimeMs - (node.MtimeMs % 1000));
        writer.WriteEntry(entry);
        if (node is MemoryDirectory folder)
        {
            foreach (var (child, value) in folder.Children)
            {
                Write(writer, name == "/" ? "/" + child : $"{name}/{child}", value);
            }
        }
    }

    private static string Canonical(List<(string Name, MemoryDirectory Folder)> chain, string last) =>
        "/" + string.Join('/', chain.Select(c => c.Name).Append(last));
}
