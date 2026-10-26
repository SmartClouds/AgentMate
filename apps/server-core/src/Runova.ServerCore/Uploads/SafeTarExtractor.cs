using System.Buffers;
using System.Globalization;
using System.IO.Compression;
using System.Text;

namespace Runova.ServerCore.Uploads;

/// <summary>
/// Unpacks an uploaded .tar.gz, such as a stack's build context, into a folder that does not exist
/// yet. The archive comes over the network and the core runs as root, so every entry is checked
/// before anything is written: no absolute paths and no "..", nothing written inside a file or
/// through a link, links that only lead to places inside the folder, no devices or pipes, and caps
/// on the entry count and the unpacked size that stop a decompression bomb at the first header
/// that would pass them. File contents are streamed, never held in memory, and a refused archive
/// leaves nothing behind.
/// </summary>
internal static class SafeTarExtractor
{
    /// <summary>What headers, padding and extended headers may add per entry on top of the contents.</summary>
    private const int OverheadPerEntry = 4 * 1024;

    /// <summary>Linux gives up after 40 links in a row (ELOOP), and so does the check here.</summary>
    private const int MaxLinkHops = 40;

    /// <summary>NAME_MAX on Linux.</summary>
    private const int MaxNameBytes = 255;

    private const int CopyBufferBytes = 81_920;

    private const UnixFileMode ReadableMode =
        UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead | UnixFileMode.OtherRead;

    private const UnixFileMode ExecutableMode =
        ReadableMode | UnixFileMode.UserExecute | UnixFileMode.GroupExecute | UnixFileMode.OtherExecute;

    public static async Task<TarExtractionResult> ExtractAsync(
        Stream archive,
        string destination,
        TarExtractionLimits limits,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(archive);
        ArgumentException.ThrowIfNullOrEmpty(destination);
        ArgumentNullException.ThrowIfNull(limits);
        cancellationToken.ThrowIfCancellationRequested();

        var root = Path.GetFullPath(destination);
        if (Directory.Exists(root) || File.Exists(root))
        {
            throw new IOException($"{root} already exists. An archive only unpacks into a new folder.");
        }

        CreateFolder(root);
        try
        {
            var unpacker = new Unpacker(root, limits);
            await unpacker.RunAsync(archive, cancellationToken);
            return unpacker.Result;
        }
        catch
        {
            RemoveQuietly(root);
            throw;
        }
    }

    private static void CreateFolder(string path)
    {
        Directory.CreateDirectory(path);
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(path, ExecutableMode);
        }
    }

    private static void RemoveQuietly(string root)
    {
        try
        {
            Directory.Delete(root, recursive: true);
        }
        catch (IOException)
        {
            // The refusal is what matters to the caller; a folder that could not be removed is
            // only ever inside the stack's own directory.
        }
        catch (UnauthorizedAccessException)
        {
            // As above.
        }
    }

    /// <summary>
    /// A name as it can safely appear in a refusal that gets shown and logged: quoted, with
    /// control and formatting characters spelled out, and cut short.
    /// </summary>
    private static string Show(string name)
    {
        const int MaxShown = 200;
        var builder = new StringBuilder("\"");
        foreach (var c in name.AsSpan(0, Math.Min(name.Length, MaxShown)))
        {
            if (char.GetUnicodeCategory(c) is UnicodeCategory.Control or UnicodeCategory.Format
                or UnicodeCategory.LineSeparator or UnicodeCategory.ParagraphSeparator)
            {
                builder.Append(CultureInfo.InvariantCulture, $"\\u{(int)c:x4}");
            }
            else
            {
                builder.Append(c);
            }
        }

        return builder.Append(name.Length > MaxShown ? "...\"" : "\"").ToString();
    }

    private static ArchiveRejectedException Refuse(string reason) => new(reason);

    private enum NodeKind
    {
        Folder,
        File,
        Link,
    }

    /// <summary>What a path in the archive became: a folder, a file (with where it went) or a link.</summary>
    private sealed record Node(NodeKind Kind, string? FullPath = null, long Size = 0, string? Target = null, UnixFileMode Mode = 0);

    private sealed class Unpacker(string root, TarExtractionLimits limits)
    {
        private readonly Dictionary<string, Node> _nodes = new(StringComparer.Ordinal);
        private readonly List<(string Key, string Target)> _links = [];
        private int _entries;
        private int _files;
        private int _folders;
        private long _bytes;

        public TarExtractionResult Result => new(_files, _folders, _links.Count, _bytes);

        public async Task RunAsync(Stream archive, CancellationToken cancellationToken)
        {
            var decompressedLimit = limits.MaxTotalBytes + ((long)limits.MaxEntries * OverheadPerEntry);
            await using var gzip = new GZipStream(archive, CompressionMode.Decompress, leaveOpen: true);
            await using var bounded = new BoundedReadStream(gzip, decompressedLimit, limits.MaxTotalBytes);
            var reader = new TarStreamReader(bounded);
            var buffer = ArrayPool<byte>.Shared.Rent(CopyBufferBytes);
            try
            {
                while (await reader.ReadNextAsync(cancellationToken) is { } header)
                {
                    await AddAsync(header, reader, buffer, cancellationToken);
                }
            }
            catch (Exception e) when (e is InvalidDataException or EndOfStreamException)
            {
                throw new ArchiveRejectedException("The upload is not a complete .tar.gz file.", e);
            }
            finally
            {
                ArrayPool<byte>.Shared.Return(buffer);
            }

            CreateLinks();
        }

        private async Task AddAsync(TarEntryHeader header, TarStreamReader reader, byte[] buffer, CancellationToken cancellationToken)
        {
            if (++_entries > limits.MaxEntries)
            {
                throw Refuse($"The archive has more than {limits.MaxEntries} entries.");
            }

            switch (header.Type)
            {
                case 'g':
                    return;
                case '0' or '7':
                    await AddFileAsync(header, reader, buffer, cancellationToken);
                    return;
                case '1':
                    NoContent(header, "a hard link");
                    AddHardLink(header.Name, header.LinkName);
                    return;
                case '2':
                    NoContent(header, "a link");
                    AddLink(header.Name, header.LinkName);
                    return;
                case '5':
                    NoContent(header, "a folder");
                    AddFolder(header.Name);
                    return;
                case '3' or '4':
                    throw Refuse($"{Show(header.Name)} is a device file. Device files are never unpacked.");
                case '6':
                    throw Refuse($"{Show(header.Name)} is a named pipe. Pipes are never unpacked.");
                default:
                    throw Refuse(
                        $"{Show(header.Name)} is a tar entry of type {Show(header.Type.ToString())}, which is never unpacked.");
            }
        }

        private static void NoContent(TarEntryHeader header, string what)
        {
            if (header.Size != 0)
            {
                throw Refuse($"{Show(header.Name)} is {what} with contents attached, which no tar program writes.");
            }
        }

        private void AddFolder(string name)
        {
            var parts = PathParts(name, Show(name));
            if (parts.Length == 0)
            {
                // "./" is the folder the archive unpacks into.
                return;
            }

            ClaimParents(parts, name);
            var key = string.Join('/', parts);
            if (_nodes.TryGetValue(key, out var existing))
            {
                if (existing.Kind == NodeKind.Folder)
                {
                    return;
                }

                throw Refuse($"{Show(name)} appears twice in the archive.");
            }

            _nodes[key] = new Node(NodeKind.Folder);
            _folders++;
            CreateFolder(FullPath(parts));
        }

        private async Task AddFileAsync(TarEntryHeader header, TarStreamReader reader, byte[] buffer, CancellationToken cancellationToken)
        {
            var parts = NamedParts(header.Name);
            ClaimParents(parts, header.Name);
            var key = ClaimNew(parts, header.Name);
            Reserve(header.Size);

            var path = FullPath(parts);
            var mode = (header.Mode & 0b001_001_001) != 0 ? ExecutableMode : ReadableMode;
            long copied;
            await using (var output = new FileStream(path, new FileStreamOptions
            {
                Mode = FileMode.CreateNew,
                Access = FileAccess.Write,
                Share = FileShare.None,
                Options = FileOptions.Asynchronous,
            }))
            {
                copied = await reader.CopyContentAsync(output, buffer, cancellationToken);
            }

            if (copied != header.Size)
            {
                throw Refuse($"{Show(header.Name)} ends before the size its header gives.");
            }

            SetMode(path, mode);
            _nodes[key] = new Node(NodeKind.File, path, header.Size, Mode: mode);
            _files++;
        }

        /// <summary>
        /// A hard link names a file that came earlier in the archive. It becomes a copy of that file,
        /// so it counts toward the size cap like one: a thousand links to one big file cannot
        /// multiply it past the cap.
        /// </summary>
        private void AddHardLink(string name, string target)
        {
            var parts = NamedParts(name);
            if (target.Length == 0)
            {
                throw Refuse($"The hard link {Show(name)} points nowhere.");
            }

            var subject = $"The hard link {Show(name)} points to {Show(target)}, which";
            var targetParts = PathParts(target, subject);
            if (!_nodes.TryGetValue(string.Join('/', targetParts), out var source) || source.Kind != NodeKind.File)
            {
                throw Refuse($"{subject} is not a file that comes earlier in the archive.");
            }

            ClaimParents(parts, name);
            var key = ClaimNew(parts, name);
            Reserve(source.Size);
            var path = FullPath(parts);
            File.Copy(source.FullPath!, path, overwrite: false);
            SetMode(path, source.Mode);
            _nodes[key] = source with { FullPath = path };
            _files++;
        }

        /// <summary>
        /// Links are checked as they arrive and again once the whole archive is in, because a later
        /// link can change where an earlier one leads. They are only created at the very end, so
        /// nothing is ever written through one.
        /// </summary>
        private void AddLink(string name, string target)
        {
            var parts = NamedParts(name);
            CheckLinkTarget(name, target);
            ClaimParents(parts, name);
            var key = ClaimNew(parts, name);
            if (Escapes(parts, target, name) is { } problem)
            {
                throw Refuse(problem);
            }

            _nodes[key] = new Node(NodeKind.Link, Target: target);
            _links.Add((key, target));
        }

        private void CreateLinks()
        {
            foreach (var (key, target) in _links)
            {
                if (Escapes(key.Split('/'), target, key) is { } problem)
                {
                    throw Refuse(problem);
                }
            }

            foreach (var (key, target) in _links)
            {
                try
                {
                    File.CreateSymbolicLink(FullPath(key.Split('/')), target.Replace('/', Path.DirectorySeparatorChar));
                }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException)
                {
                    throw new ArchiveRejectedException(
                        $"{Show(key)} is a link, and this system would not create it: {e.Message}", e);
                }
            }
        }

        /// <summary>
        /// Follows a link the way the kernel would, through the other links in the archive, and
        /// says why it is refused, or returns null when it stays inside. Spelling a path out is
        /// not enough: "a/b/.." reads as "a", but when "a/b" is itself a link the kernel follows
        /// it first and ".." then leaves from wherever it went.
        /// </summary>
        private string? Escapes(string[] linkParts, string target, string name)
        {
            var resolved = new List<string>(linkParts[..^1]);
            var pending = new LinkedList<string>(target.Split('/', StringSplitOptions.RemoveEmptyEntries));
            var hops = 0;
            while (pending.First is { } next)
            {
                pending.RemoveFirst();
                var part = next.Value;
                if (part == ".")
                {
                    continue;
                }

                if (part == "..")
                {
                    if (resolved.Count == 0)
                    {
                        return $"{Show(name)} is a link that leads outside the folder the archive unpacks into.";
                    }

                    resolved.RemoveAt(resolved.Count - 1);
                    continue;
                }

                resolved.Add(part);
                if (_nodes.TryGetValue(string.Join('/', resolved), out var node) && node.Kind == NodeKind.Link)
                {
                    if (++hops > MaxLinkHops)
                    {
                        return $"{Show(name)} is part of a loop of links.";
                    }

                    resolved.RemoveAt(resolved.Count - 1);
                    var hop = node.Target!.Split('/', StringSplitOptions.RemoveEmptyEntries);
                    for (var i = hop.Length - 1; i >= 0; i--)
                    {
                        pending.AddFirst(hop[i]);
                    }
                }
            }

            return null;
        }

        private void CheckLinkTarget(string name, string target)
        {
            var subject = $"The link {Show(name)} points to {Show(target)}, which";
            if (target.Length == 0)
            {
                throw Refuse($"The link {Show(name)} points nowhere.");
            }

            CheckCharacters(target, subject);
            if (Encoding.UTF8.GetByteCount(target) > limits.MaxPathBytes)
            {
                throw Refuse($"{subject} is longer than {limits.MaxPathBytes} bytes.");
            }
        }

        /// <summary>The parts of an entry's own path, which has to name something below the folder.</summary>
        private string[] NamedParts(string name)
        {
            var parts = PathParts(name, Show(name));
            return parts.Length > 0
                ? parts
                : throw Refuse($"{Show(name)} names the folder the archive unpacks into, not something in it.");
        }

        /// <summary>
        /// The parts of a path in the archive, or a refusal that says what is wrong with it. Empty
        /// parts and "." are dropped, since "./a//b" names the same file as "a/b"; ".." is refused
        /// wherever it appears, even where it would stay inside.
        /// </summary>
        private string[] PathParts(string path, string subject)
        {
            if (path.Length == 0)
            {
                throw Refuse("An entry in the archive has no name.");
            }

            CheckCharacters(path, subject);
            var parts = path.Split('/', StringSplitOptions.RemoveEmptyEntries).Where(part => part != ".").ToArray();
            if (parts.Contains(".."))
            {
                throw Refuse($"{subject} uses \"..\" to climb out of the folder the archive unpacks into.");
            }

            if (parts.Length > limits.MaxDepth)
            {
                throw Refuse($"{subject} is nested {parts.Length} folders deep, more than the {limits.MaxDepth} allowed.");
            }

            if (parts.Any(part => Encoding.UTF8.GetByteCount(part) > MaxNameBytes))
            {
                throw Refuse($"{subject} has a name longer than {MaxNameBytes} bytes.");
            }

            if (Encoding.UTF8.GetByteCount(path) > limits.MaxPathBytes)
            {
                throw Refuse($"{subject} is longer than {limits.MaxPathBytes} bytes.");
            }

            return parts;
        }

        private static void CheckCharacters(string path, string subject)
        {
            if (path.Any(char.IsControl))
            {
                throw Refuse($"{subject} has a control character in its path.");
            }

            if (path.Contains('\\', StringComparison.Ordinal))
            {
                throw Refuse($"{subject} has a backslash in its path. Tar paths use forward slashes, and Windows reads a backslash as a folder.");
            }

            if (path[0] == '/')
            {
                throw Refuse($"{subject} is an absolute path. Everything in the archive must be relative to the folder it unpacks into.");
            }

            if (path.Length >= 2 && char.IsAsciiLetter(path[0]) && path[1] == ':')
            {
                throw Refuse($"{subject} is an absolute Windows path. Everything in the archive must be relative to the folder it unpacks into.");
            }

            if (path.Contains(':', StringComparison.Ordinal))
            {
                throw Refuse($"{subject} has a colon in its path, which Windows reads as a hidden stream.");
            }
        }

        /// <summary>
        /// Checks every folder above an entry: none may be a file or a link, and the ones the
        /// archive never listed are created on the way down.
        /// </summary>
        private void ClaimParents(string[] parts, string name)
        {
            for (var depth = 1; depth < parts.Length; depth++)
            {
                var key = string.Join('/', parts[..depth]);
                if (!_nodes.TryGetValue(key, out var node))
                {
                    _nodes[key] = new Node(NodeKind.Folder);
                    _folders++;
                    CreateFolder(FullPath(parts[..depth]));
                    continue;
                }

                if (node.Kind == NodeKind.Link)
                {
                    throw Refuse($"{Show(name)} would be written through the link {Show(key)}.");
                }

                if (node.Kind == NodeKind.File)
                {
                    throw Refuse($"{Show(name)} would go inside the file {Show(key)}.");
                }
            }
        }

        private string ClaimNew(string[] parts, string name)
        {
            var key = string.Join('/', parts);
            return _nodes.ContainsKey(key) ? throw Refuse($"{Show(name)} appears twice in the archive.") : key;
        }

        private void Reserve(long size)
        {
            if (size < 0 || size > limits.MaxTotalBytes - _bytes)
            {
                throw Refuse($"Unpacked, the archive would be larger than {Sizes.Describe(limits.MaxTotalBytes)}.");
            }

            _bytes += size;
        }

        private string FullPath(string[] parts)
        {
            var path = Path.Join(root, string.Join(Path.DirectorySeparatorChar, parts));

            // The parts were checked one by one already; this is the backstop.
            return path.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal)
                ? path
                : throw Refuse($"{Show(string.Join('/', parts))} would land outside the folder the archive unpacks into.");
        }

        private static void SetMode(string path, UnixFileMode mode)
        {
            if (!OperatingSystem.IsWindows())
            {
                File.SetUnixFileMode(path, mode);
            }
        }
    }

    /// <summary>
    /// Passes reads through and refuses the archive as soon as the decompressed stream has given
    /// more than it ever could for an archive within the caps.
    /// </summary>
    private sealed class BoundedReadStream(Stream inner, long limit, long reportedLimit) : Stream
    {
        private long _read;

        public override bool CanRead => true;

        public override bool CanSeek => false;

        public override bool CanWrite => false;

        public override long Length => throw new NotSupportedException();

        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public override int Read(byte[] buffer, int offset, int count) => Count(inner.Read(buffer, offset, count));

        public override int Read(Span<byte> buffer) => Count(inner.Read(buffer));

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) =>
            Count(await inner.ReadAsync(buffer, cancellationToken));

        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
            ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();

        public override void Flush()
        {
        }

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        private int Count(int read)
        {
            _read += read;
            return _read > limit
                ? throw Refuse($"Unpacked, the archive would be larger than {Sizes.Describe(reportedLimit)}.")
                : read;
        }
    }
}
