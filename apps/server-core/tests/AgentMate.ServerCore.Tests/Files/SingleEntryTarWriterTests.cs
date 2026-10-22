using System.Formats.Tar;
using System.Text;
using AgentMate.ServerCore.Files;
using AgentMate.ServerCore.Uploads;

namespace AgentMate.ServerCore.Tests.Files;

/// <summary>
/// An upload goes into the container as a one-entry tar wrapped around the request body as it
/// arrives. The archives are read back with .NET's own TarReader, so the writer is checked against
/// a reader it shares nothing with.
/// </summary>
public sealed class SingleEntryTarWriterTests
{
    private static readonly DateTimeOffset _mtime = DateTimeOffset.FromUnixTimeSeconds(1_792_628_316);

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private static TarEntrySpec File(string name, long size, int uid = 999, int gid = 998, int mode = 0b110_100_100) =>
        new(name, TarEntrySpec.RegularFile, size, mode, uid, gid, _mtime);

    private static byte[] Body(int size) => [.. Enumerable.Range(0, size).Select(i => (byte)((i * 31) % 251))];

    private static async Task<byte[]> ReadAllAsync(Stream stream)
    {
        using var copy = new MemoryStream();
        await stream.CopyToAsync(copy, Cancel);
        return copy.ToArray();
    }

    private static async Task<(TarEntry Entry, byte[] Content)> ReadSingleAsync(byte[] archive)
    {
        await using var reader = new TarReader(new MemoryStream(archive));
        var entry = await reader.GetNextEntryAsync(copyData: true, Cancel);
        Assert.NotNull(entry);
        var content = entry.DataStream is { } data ? await ReadAllAsync(data) : [];
        Assert.Null(await reader.GetNextEntryAsync(cancellationToken: Cancel));
        return (entry, content);
    }

    [Fact]
    public async Task Wraps_a_body_into_one_entry_with_its_owner_mode_and_time()
    {
        var body = Body(70_000);

        var archive = await ReadAllAsync(SingleEntryTarWriter.Wrap(File(".a.agentmate-0badf00d.part", body.Length), new MemoryStream(body)));

        var (entry, content) = await ReadSingleAsync(archive);
        Assert.Equal(".a.agentmate-0badf00d.part", entry.Name);
        Assert.Equal(TarEntryType.RegularFile, entry.EntryType);
        Assert.Equal(999, entry.Uid);
        Assert.Equal(998, entry.Gid);
        Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead | UnixFileMode.OtherRead, entry.Mode);
        Assert.Equal(_mtime, entry.ModificationTime);
        Assert.Equal(body, content);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(511)]
    [InlineData(512)]
    [InlineData(513)]
    [InlineData(1024)]
    public async Task Pads_the_body_to_whole_blocks_and_ends_with_two_empty_ones(int size)
    {
        var archive = await ReadAllAsync(SingleEntryTarWriter.Wrap(File("f", size), new MemoryStream(Body(size))));

        var padded = (size + 511) / 512 * 512;
        Assert.Equal(512 + padded + 1024, archive.Length);
        Assert.Equal(512 + padded + 1024, SingleEntryTarWriter.ArchiveLength(File("f", size)));
        Assert.All(archive[^1024..], b => Assert.Equal(0, b));
        Assert.All(archive[(512 + size)..(512 + padded)], b => Assert.Equal(0, b));
        Assert.Equal(Body(size), (await ReadSingleAsync(archive)).Content);
    }

    [Theory]
    [InlineData(101)]
    [InlineData(255)]
    public async Task Writes_a_long_name_in_a_pax_header(int length)
    {
        var name = new string('n', length);

        var archive = await ReadAllAsync(SingleEntryTarWriter.Wrap(File(name, 3), new MemoryStream("abc"u8.ToArray())));

        var (entry, content) = await ReadSingleAsync(archive);
        Assert.Equal(name, entry.Name);
        Assert.Equal("abc"u8.ToArray(), content);
        Assert.Equal(SingleEntryTarWriter.ArchiveLength(File(name, 3)), archive.Length);
    }

    [Theory]
    [InlineData("ünïcødé 文件.txt")]
    [InlineData("line\nbreak")]
    [InlineData("with space")]
    public async Task Keeps_any_name_byte_for_byte(string name)
    {
        var archive = await ReadAllAsync(SingleEntryTarWriter.Wrap(File(name, 1), new MemoryStream("x"u8.ToArray())));

        Assert.Equal(name, (await ReadSingleAsync(archive)).Entry.Name);
    }

    [Fact]
    public async Task Writes_ids_too_large_for_the_ustar_field_in_the_pax_header()
    {
        var archive = await ReadAllAsync(SingleEntryTarWriter.Wrap(File("f", 1, uid: 3_000_000, gid: 2_097_152), new MemoryStream("x"u8.ToArray())));

        var (entry, _) = await ReadSingleAsync(archive);
        Assert.Equal(3_000_000, entry.Uid);
        Assert.Equal(2_097_152, entry.Gid);
    }

    [Fact]
    public async Task A_body_shorter_than_announced_is_refused()
    {
        var wrapped = SingleEntryTarWriter.Wrap(File("f", 10), new MemoryStream(Body(9)));

        await Assert.ThrowsAsync<InvalidDataException>(() => ReadAllAsync(wrapped));
    }

    [Fact]
    public async Task A_body_longer_than_announced_is_refused_before_the_archive_ends()
    {
        var wrapped = SingleEntryTarWriter.Wrap(File("f", 10), new MemoryStream(Body(11)));
        var read = new MemoryStream();
        var buffer = new byte[100];

        var refused = await Assert.ThrowsAsync<InvalidDataException>(async () =>
        {
            int count;
            while ((count = await wrapped.ReadAsync(buffer, Cancel)) > 0)
            {
                read.Write(buffer, 0, count);
            }
        });

        Assert.True(read.Length < 512 + 512 + 1024, "The end-of-archive blocks went out before the extra byte was noticed.");
        Assert.Contains("more", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Reads_the_body_only_as_the_archive_is_read()
    {
        var body = new CountingStream(new MemoryStream(Body(100_000)));
        var wrapped = SingleEntryTarWriter.Wrap(File("big", 100_000), body);

        var header = new byte[512];
        await wrapped.ReadExactlyAsync(header, Cancel);

        Assert.Equal(0, body.BytesRead);
        await wrapped.ReadExactlyAsync(new byte[4096], Cancel);
        Assert.InRange(body.BytesRead, 4096, 100_000 - 1);
    }

    [Fact]
    public async Task Writes_a_folder_entry()
    {
        var archive = SingleEntryTarWriter.Folder("new folder", 0b111_101_101, 33, 34, _mtime);

        var (entry, content) = await ReadSingleAsync(archive);
        Assert.Equal(TarEntryType.Directory, entry.EntryType);
        Assert.Equal("new folder/", entry.Name);
        Assert.Equal(33, entry.Uid);
        Assert.Equal(34, entry.Gid);
        Assert.Equal((UnixFileMode)0b111_101_101, entry.Mode);
        Assert.Empty(content);
    }

    [Fact]
    public async Task The_cores_own_tar_reader_reads_owner_and_time_back()
    {
        var archive = await ReadAllAsync(SingleEntryTarWriter.Wrap(File("owned", 2, uid: 3_000_000, gid: 70), new MemoryStream("hi"u8.ToArray())));

        var header = await new TarStreamReader(new MemoryStream(archive)).ReadNextAsync(Cancel);

        Assert.NotNull(header);
        Assert.Equal(3_000_000, header.Uid);
        Assert.Equal(70, header.Gid);
        Assert.Equal(_mtime.ToUnixTimeMilliseconds(), header.MtimeUnixMs);
    }

    [Theory]
    [InlineData("")]
    [InlineData("a/b")]
    [InlineData("nul\0")]
    [InlineData("..")]
    public void Refuses_a_name_that_is_not_one_plain_segment(string name)
    {
        Assert.Throws<ArgumentException>(() => SingleEntryTarWriter.Wrap(File(name, 0), Stream.Null));
    }

    [Fact]
    public void Refuses_a_negative_size()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => SingleEntryTarWriter.Wrap(File("f", -1), Stream.Null));
    }

    private sealed class CountingStream(Stream inner) : Stream
    {
        public long BytesRead { get; private set; }

        public override bool CanRead => true;

        public override bool CanSeek => false;

        public override bool CanWrite => false;

        public override long Length => throw new NotSupportedException();

        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            var read = inner.Read(buffer, offset, count);
            BytesRead += read;
            return read;
        }

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            var read = await inner.ReadAsync(buffer, cancellationToken);
            BytesRead += read;
            return read;
        }

        public override void Flush()
        {
        }

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
