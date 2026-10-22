using System.Globalization;
using System.Text;

namespace AgentMate.ServerCore.Uploads;

/// <summary>
/// One entry's header, with PAX and GNU long names and sizes already applied. <see cref="Type"/>
/// is the tar typeflag: '0' file, '1' hard link, '2' symbolic link, '5' folder, and so on. The
/// owner and time come from the header or, when it has them, its PAX record.
/// </summary>
internal sealed record TarEntryHeader(char Type, string Name, string LinkName, long Size, int Mode, int Uid = 0, int Gid = 0, long MtimeUnixMs = 0);

/// <summary>
/// Reads a tar stream one header at a time, for ustar, PAX and GNU archives. It exists because
/// System.Formats.Tar's TarReader rents a buffer as large as an extended header says it is before
/// reading a byte of it, so a few hundred bytes of upload could make the core allocate gigabytes.
/// Here extended headers are capped, file contents are only ever streamed, and a header whose
/// checksum does not add up ends the read.
/// </summary>
internal sealed class TarStreamReader(Stream stream)
{
    public const int BlockSize = 512;

    /// <summary>For a PAX or GNU long-name block: room for a 4 KB path and its attributes many times over.</summary>
    public const int MaxMetadataBytes = 64 * 1024;

    private static readonly UTF8Encoding _strictUtf8 = new(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);

    private readonly byte[] _block = new byte[BlockSize];
    private long _remaining;
    private int _padding;
    private bool _ended;

    /// <summary>
    /// The next entry, or null at the end of the archive. Whatever the caller left unread of the
    /// previous entry's contents is skipped first.
    /// </summary>
    public async Task<TarEntryHeader?> ReadNextAsync(CancellationToken cancellationToken)
    {
        await SkipAsync(_remaining + _padding, cancellationToken);
        _remaining = 0;
        _padding = 0;
        if (_ended)
        {
            return null;
        }

        var pending = new PendingNames();
        while (true)
        {
            await stream.ReadExactlyAsync(_block, cancellationToken);
            if (!_block.AsSpan().ContainsAnyExcept((byte)0))
            {
                if (pending.Any)
                {
                    throw Invalid("it ends right after an extended header");
                }

                _ended = true;
                return null;
            }

            VerifyChecksum(_block);
            var type = (char)_block[156];
            var size = ParseNumber(_block.AsSpan(124, 12), "size");
            switch (type)
            {
                case 'x':
                    pending.Saw(type);
                    ReadPaxRecords(await ReadMetadataAsync(size, cancellationToken), pending);
                    continue;
                case 'L':
                    pending.Saw(type);
                    pending.Name = DecodeName(TrimNul(await ReadMetadataAsync(size, cancellationToken)));
                    continue;
                case 'K':
                    pending.Saw(type);
                    pending.LinkName = DecodeName(TrimNul(await ReadMetadataAsync(size, cancellationToken)));
                    continue;
                case 'g':
                    if (pending.Any)
                    {
                        throw Invalid("a global header follows an extended header");
                    }

                    // Global attributes set defaults such as owners and times, none of which is used here.
                    await ReadMetadataAsync(size, cancellationToken);
                    return new TarEntryHeader('g', string.Empty, string.Empty, 0, 0);
                default:
                    break;
            }

            var header = new TarEntryHeader(
                type == '\0' ? '0' : type,
                pending.Name ?? ReadName(_block),
                pending.LinkName ?? DecodeName(TrimNul(_block.AsSpan(157, 100))),
                pending.Size ?? size,
                (int)ParseNumber(_block.AsSpan(100, 8), "mode"),
                pending.Uid ?? (int)Informational(_block.AsSpan(108, 8)),
                pending.Gid ?? (int)Informational(_block.AsSpan(116, 8)),
                pending.MtimeUnixMs ?? (Informational(_block.AsSpan(136, 12)) * 1000));
            _remaining = header.Size;
            _padding = Padding(header.Size);
            return header;
        }
    }

    /// <summary>Reads the next bytes of the current entry's contents; 0 once they are all read.</summary>
    public async ValueTask<int> ReadContentAsync(Memory<byte> buffer, CancellationToken cancellationToken)
    {
        if (_remaining == 0 || buffer.IsEmpty)
        {
            return 0;
        }

        var read = await stream.ReadAsync(buffer[..(int)Math.Min(buffer.Length, _remaining)], cancellationToken);
        if (read == 0)
        {
            throw new EndOfStreamException();
        }

        _remaining -= read;
        return read;
    }

    /// <summary>Copies the current entry's contents, returning how many bytes there were.</summary>
    public async Task<long> CopyContentAsync(Stream destination, byte[] buffer, CancellationToken cancellationToken)
    {
        long copied = 0;
        while (_remaining > 0)
        {
            var read = await stream.ReadAsync(buffer.AsMemory(0, (int)Math.Min(buffer.Length, _remaining)), cancellationToken);
            if (read == 0)
            {
                throw new EndOfStreamException();
            }

            await destination.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
            _remaining -= read;
            copied += read;
        }

        return copied;
    }

    private async Task<byte[]> ReadMetadataAsync(long size, CancellationToken cancellationToken)
    {
        if (size > MaxMetadataBytes)
        {
            throw new ArchiveRejectedException(
                $"The archive has an extended header of {Sizes.Describe(size)}, larger than the " +
                $"{Sizes.Describe(MaxMetadataBytes)} such a header may be.");
        }

        var data = new byte[size];
        await stream.ReadExactlyAsync(data, cancellationToken);
        await SkipAsync(Padding(size), cancellationToken);
        return data;
    }

    private async Task SkipAsync(long count, CancellationToken cancellationToken)
    {
        while (count > 0)
        {
            var chunk = (int)Math.Min(count, _block.Length);
            await stream.ReadExactlyAsync(_block.AsMemory(0, chunk), cancellationToken);
            count -= chunk;
        }
    }

    private static int Padding(long size) => (int)((BlockSize - (size % BlockSize)) % BlockSize);

    /// <summary>
    /// The name field, joined to the ustar prefix field when there is one. GNU archives use the
    /// prefix bytes for other things, which their "ustar  " magic gives away.
    /// </summary>
    private static string ReadName(byte[] block)
    {
        var name = DecodeName(TrimNul(block.AsSpan(0, 100)));
        var posix = block.AsSpan(257, 6).SequenceEqual("ustar\0"u8);
        if (!posix)
        {
            return name;
        }

        var prefix = DecodeName(TrimNul(block.AsSpan(345, 155)));
        return prefix.Length == 0 ? name : $"{prefix}/{name}";
    }

    /// <summary>
    /// The PAX records this reader acts on: the entry's path, link target and size, and for
    /// reading only, its owner and time (a value that is not a number leaves the header's).
    /// Anything else (other times, owner names, vendor attributes) is read past, except
    /// sparse-file maps, whose contents would unpack as garbage.
    /// </summary>
    private static void ReadPaxRecords(ReadOnlySpan<byte> data, PendingNames pending)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        while (!data.IsEmpty)
        {
            var space = data.IndexOf((byte)' ');
            if (space <= 0
                || !int.TryParse(data[..space], NumberStyles.None, CultureInfo.InvariantCulture, out var length)
                || length <= space + 2
                || length > data.Length
                || data[length - 1] != (byte)'\n')
            {
                throw Invalid("an extended header record is malformed");
            }

            var record = data[(space + 1)..(length - 1)];
            var equals = record.IndexOf((byte)'=');
            if (equals <= 0)
            {
                throw Invalid("an extended header record has no key");
            }

            var key = DecodeName(record[..equals]);
            if (!seen.Add(key))
            {
                throw Invalid($"an extended header sets {key} twice");
            }

            var value = record[(equals + 1)..];
            switch (key)
            {
                case "path":
                    pending.Name = DecodeName(value);
                    break;
                case "linkpath":
                    pending.LinkName = DecodeName(value);
                    break;
                case "size":
                    if (value.IsEmpty
                        || !long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var size))
                    {
                        throw Invalid("an extended header has a size that is not a number");
                    }

                    pending.Size = size;
                    break;
                case "uid":
                    pending.Uid = int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var uid) ? uid : null;
                    break;
                case "gid":
                    pending.Gid = int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var gid) ? gid : null;
                    break;
                case "mtime":
                    pending.MtimeUnixMs = decimal.TryParse(value, NumberStyles.AllowDecimalPoint | NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var seconds)
                        && Math.Abs(seconds) < 1e13m
                        ? (long)decimal.Floor(seconds * 1000)
                        : null;
                    break;
                default:
                    if (key.StartsWith("GNU.sparse.", StringComparison.Ordinal))
                    {
                        throw new ArchiveRejectedException(
                            "The archive holds a sparse file, which is not unpacked. Pack the files without --sparse.");
                    }

                    break;
            }

            data = data[length..];
        }
    }

    /// <summary>An owner or a time, which only describes the entry: one that does not parse reads as 0.</summary>
    private static long Informational(ReadOnlySpan<byte> field)
    {
        try
        {
            return ParseNumber(field, "field");
        }
        catch (ArchiveRejectedException)
        {
            return 0;
        }
    }

    /// <summary>
    /// A tar number: octal digits padded with spaces or NULs, or GNU's base-256 form (first byte
    /// 0x80) for values octal cannot hold. Negative base-256 values mean nothing here.
    /// </summary>
    private static long ParseNumber(ReadOnlySpan<byte> field, string what)
    {
        if ((field[0] & 0x80) != 0)
        {
            if (field[0] != 0x80)
            {
                throw Invalid($"a header has a negative {what}");
            }

            long big = 0;
            foreach (var b in field[1..])
            {
                if (big > (long.MaxValue >> 8))
                {
                    throw Invalid($"a header has a {what} too large to be real");
                }

                big = (big << 8) | b;
            }

            return big;
        }

        long value = 0;
        foreach (var b in field.Trim(" \0"u8))
        {
            if (b is < (byte)'0' or > (byte)'7' || value > (long.MaxValue >> 3))
            {
                throw Invalid($"a header's {what} is not an octal number");
            }

            value = (value << 3) + (b - '0');
        }

        return value;
    }

    /// <summary>
    /// The header checksum: the sum of all 512 bytes with the checksum field counted as spaces.
    /// Old tar programs summed signed bytes, so either sum is accepted.
    /// </summary>
    private static void VerifyChecksum(byte[] block)
    {
        var stored = ParseNumber(block.AsSpan(148, 8), "checksum");
        long unsignedSum = 0;
        long signedSum = 0;
        for (var i = 0; i < BlockSize; i++)
        {
            var b = i is >= 148 and < 156 ? (byte)' ' : block[i];
            unsignedSum += b;
            signedSum += (sbyte)b;
        }

        if (stored != unsignedSum && stored != signedSum)
        {
            throw Invalid("a header's checksum does not match its contents");
        }
    }

    private static ReadOnlySpan<byte> TrimNul(ReadOnlySpan<byte> field)
    {
        var end = field.IndexOf((byte)0);
        return end < 0 ? field : field[..end];
    }

    private static string DecodeName(ReadOnlySpan<byte> bytes)
    {
        try
        {
            return _strictUtf8.GetString(bytes);
        }
        catch (DecoderFallbackException e)
        {
            throw new ArchiveRejectedException("The archive has a name that is not valid UTF-8.", e);
        }
    }

    private static ArchiveRejectedException Invalid(string problem) =>
        new($"The upload is not a valid tar archive: {problem}.");

    /// <summary>What PAX and GNU headers said about the entry that follows them.</summary>
    private sealed class PendingNames
    {
        private readonly HashSet<char> _kinds = [];

        public string? Name { get; set; }

        public string? LinkName { get; set; }

        public long? Size { get; set; }

        public int? Uid { get; set; }

        public int? Gid { get; set; }

        public long? MtimeUnixMs { get; set; }

        public bool Any => _kinds.Count > 0;

        /// <summary>Each kind of extended header may come once before the entry it describes.</summary>
        public void Saw(char kind)
        {
            if (!_kinds.Add(kind))
            {
                throw Invalid("two extended headers of the same kind come before one entry");
            }
        }
    }
}
