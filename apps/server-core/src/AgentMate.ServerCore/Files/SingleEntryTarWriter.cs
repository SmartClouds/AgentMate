using System.Globalization;
using System.Text;

namespace AgentMate.ServerCore.Files;

/// <summary>One tar entry to write: a file of a known size, or a folder.</summary>
/// <param name="Name">One path segment; the archive is extracted into the folder it belongs in.</param>
internal sealed record TarEntrySpec(string Name, char Type, long Size, int Mode, int Uid, int Gid, DateTimeOffset Mtime)
{
    public const char RegularFile = '0';
    public const char Directory = '5';
}

/// <summary>
/// Writes a one-entry tar for the archive API: a ustar header (with a PAX header first when the
/// name, an id or the size does not fit ustar's fields), the body, padding to a whole block and
/// the two empty blocks that end an archive. <see cref="Wrap"/> reads the body only as the archive
/// is read, so an upload streams from the request into Docker without being held anywhere, and a
/// body that is shorter or longer than announced fails the read instead of writing a wrong file.
/// </summary>
internal static class SingleEntryTarWriter
{
    public const int BlockSize = 512;

    private const int EndOfArchive = 2 * BlockSize;
    private const long MaxOctal7 = 0x1FFFFF;
    private const long MaxOctal11 = 0x1FFFFFFFF;

    public static Stream Wrap(TarEntrySpec spec, Stream body)
    {
        ArgumentNullException.ThrowIfNull(spec);
        ArgumentNullException.ThrowIfNull(body);
        return new WrappedBody(Header(spec), body, spec.Size);
    }

    /// <summary>The whole archive's length, for a Content-Length.</summary>
    public static long ArchiveLength(TarEntrySpec spec)
    {
        ArgumentNullException.ThrowIfNull(spec);
        return Header(spec).Length + spec.Size + Padding(spec.Size) + EndOfArchive;
    }

    /// <summary>An archive holding one empty folder.</summary>
    public static byte[] Folder(string name, int mode, int uid, int gid, DateTimeOffset mtime)
    {
        var header = Header(new TarEntrySpec(name, TarEntrySpec.Directory, 0, mode, uid, gid, mtime));
        var archive = new byte[header.Length + EndOfArchive];
        header.CopyTo(archive, 0);
        return archive;
    }

    private static int Padding(long size) => (int)((BlockSize - (size % BlockSize)) % BlockSize);

    private static byte[] Header(TarEntrySpec spec)
    {
        if (!FilePaths.IsValidName(spec.Name))
        {
            throw new ArgumentException("A tar entry here is one plain name.", nameof(spec));
        }

        ArgumentOutOfRangeException.ThrowIfNegative(spec.Size);
        var directory = spec.Type == TarEntrySpec.Directory;
        var name = directory ? spec.Name + "/" : spec.Name;
        var nameBytes = Encoding.UTF8.GetBytes(name);
        var records = new List<(string Key, string Value)>();
        if (nameBytes.Length > 100 || !Ascii.IsValid(nameBytes))
        {
            records.Add(("path", name));
        }

        if (spec.Uid is < 0 or > (int)MaxOctal7)
        {
            records.Add(("uid", ((uint)spec.Uid).ToString(CultureInfo.InvariantCulture)));
        }

        if (spec.Gid is < 0 or > (int)MaxOctal7)
        {
            records.Add(("gid", ((uint)spec.Gid).ToString(CultureInfo.InvariantCulture)));
        }

        if (spec.Size > MaxOctal11)
        {
            records.Add(("size", spec.Size.ToString(CultureInfo.InvariantCulture)));
        }

        var mtime = Math.Clamp(spec.Mtime.ToUnixTimeSeconds(), 0, MaxOctal11);
        var entry = Block(
            records.Count == 0 ? nameBytes : Encoding.ASCII.GetBytes(directory ? "agentmate-entry/" : "agentmate-entry"),
            spec.Mode & 0xFFF,
            spec.Uid is >= 0 and <= (int)MaxOctal7 ? spec.Uid : 0,
            spec.Gid is >= 0 and <= (int)MaxOctal7 ? spec.Gid : 0,
            spec.Size <= MaxOctal11 ? spec.Size : 0,
            mtime,
            (byte)spec.Type);
        if (records.Count == 0)
        {
            return entry;
        }

        var pax = PaxRecords(records);
        var paxHeader = Block(Encoding.ASCII.GetBytes("PaxHeaders/agentmate-entry"), 0x1A4, 0, 0, pax.Length, mtime, (byte)'x');
        var all = new byte[paxHeader.Length + pax.Length + Padding(pax.Length) + entry.Length];
        paxHeader.CopyTo(all, 0);
        pax.CopyTo(all, paxHeader.Length);
        entry.CopyTo(all, all.Length - entry.Length);
        return all;
    }

    /// <summary>"LEN key=value\n" each, where LEN counts the whole record, its own digits included.</summary>
    private static byte[] PaxRecords(List<(string Key, string Value)> records)
    {
        var data = new List<byte>();
        foreach (var (key, value) in records)
        {
            var body = Encoding.UTF8.GetBytes($" {key}={value}\n");
            var length = body.Length + 1;
            while (length != body.Length + length.ToString(CultureInfo.InvariantCulture).Length)
            {
                length = body.Length + length.ToString(CultureInfo.InvariantCulture).Length;
            }

            data.AddRange(Encoding.ASCII.GetBytes(length.ToString(CultureInfo.InvariantCulture)));
            data.AddRange(body);
        }

        return [.. data];
    }

    private static byte[] Block(byte[] name, int mode, int uid, int gid, long size, long mtime, byte type)
    {
        var block = new byte[BlockSize];
        name.CopyTo(block, 0);
        Octal(block, 100, 8, mode);
        Octal(block, 108, 8, uid);
        Octal(block, 116, 8, gid);
        Octal(block, 124, 12, size);
        Octal(block, 136, 12, mtime);
        block[156] = type;
        "ustar\0"u8.CopyTo(block.AsSpan(257));
        "00"u8.CopyTo(block.AsSpan(263));
        Octal(block, 329, 8, 0);
        Octal(block, 337, 8, 0);
        block.AsSpan(148, 8).Fill((byte)' ');
        var sum = block.Sum(b => (long)b);
        Encoding.ASCII.GetBytes(Convert.ToString(sum, 8).PadLeft(6, '0') + "\0 ").CopyTo(block, 148);
        return block;
    }

    /// <summary>Zero-padded octal digits filling the field but its last byte, which is a NUL.</summary>
    private static void Octal(byte[] block, int offset, int length, long value) =>
        Encoding.ASCII.GetBytes(Convert.ToString(value, 8).PadLeft(length - 1, '0')).CopyTo(block, offset);

    /// <summary>The archive as a read-only stream: header, exactly the announced body, then the ending.</summary>
    private sealed class WrappedBody(byte[] header, Stream body, long size) : Stream
    {
        private readonly byte[] _ending = new byte[Padding(size) + EndOfArchive];
        private long _position;
        private long _bodyRead;
        private bool _checked;
        private int _endingSent;

        public override bool CanRead => true;

        public override bool CanSeek => false;

        public override bool CanWrite => false;

        public override long Length => header.Length + size + _ending.Length;

        public override long Position
        {
            get => _position;
            set => throw new NotSupportedException();
        }

        public override int Read(byte[] buffer, int offset, int count) =>
            ReadCoreAsync(buffer.AsMemory(offset, count), sync: true, CancellationToken.None).AsTask().GetAwaiter().GetResult();

        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) =>
            ReadCoreAsync(buffer, sync: false, cancellationToken);

        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
            ReadCoreAsync(buffer.AsMemory(offset, count), sync: false, cancellationToken).AsTask();

        public override void Flush()
        {
        }

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                body.Dispose();
            }

            base.Dispose(disposing);
        }

        private async ValueTask<int> ReadCoreAsync(Memory<byte> buffer, bool sync, CancellationToken cancellationToken)
        {
            if (buffer.IsEmpty)
            {
                return 0;
            }

            int count;
            if (_position < header.Length)
            {
                count = (int)Math.Min(buffer.Length, header.Length - _position);
                header.AsMemory((int)_position, count).CopyTo(buffer);
            }
            else if (_bodyRead < size)
            {
                var want = buffer[..(int)Math.Min(buffer.Length, size - _bodyRead)];
                count = sync ? body.Read(want.Span) : await body.ReadAsync(want, cancellationToken);
                if (count == 0)
                {
                    throw new InvalidDataException($"The upload ended after {_bodyRead} of the {size} bytes it announced.");
                }

                _bodyRead += count;
            }
            else
            {
                if (!_checked)
                {
                    var extra = new byte[1];
                    var more = sync ? body.Read(extra) : await body.ReadAsync(extra, cancellationToken);
                    if (more > 0)
                    {
                        throw new InvalidDataException($"The upload sent more than the {size} bytes it announced.");
                    }

                    _checked = true;
                }

                count = Math.Min(buffer.Length, _ending.Length - _endingSent);
                _ending.AsMemory(_endingSent, count).CopyTo(buffer);
                _endingSent += count;
            }

            _position += count;
            return count;
        }
    }
}
