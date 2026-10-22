using System.Formats.Tar;
using AgentMate.ServerCore.Files;

namespace AgentMate.ServerCore.Tests.Files;

/// <summary>
/// A download is the archive API's tar of one path; the core takes the first entry's body out and
/// streams it as plain bytes. Folders and links are refused: the app downloads files.
/// </summary>
public sealed class ArchiveUnwrapTests
{
    private static readonly DateTimeOffset _mtime = DateTimeOffset.FromUnixTimeSeconds(1_792_628_316);

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private static MemoryStream Archive(TarEntryFormat format, params TarEntry[] entries)
    {
        var archive = new MemoryStream();
        using (var writer = new TarWriter(archive, format, leaveOpen: true))
        {
            foreach (var entry in entries)
            {
                writer.WriteEntry(entry);
            }
        }

        archive.Position = 0;
        return archive;
    }

    private static TarEntry File(TarEntryFormat format, string name, byte[] content, int uid = 0, int gid = 0)
    {
        TarEntry entry = format switch
        {
            TarEntryFormat.Gnu => new GnuTarEntry(TarEntryType.RegularFile, name),
            TarEntryFormat.Ustar => new UstarTarEntry(TarEntryType.RegularFile, name),
            _ => new PaxTarEntry(TarEntryType.RegularFile, name),
        };
        entry.DataStream = new MemoryStream(content);
        entry.Uid = uid;
        entry.Gid = gid;
        entry.ModificationTime = _mtime;
        entry.Mode = (UnixFileMode)0b110_100_000;
        return entry;
    }

    private static async Task<byte[]> ReadAllAsync(Stream stream)
    {
        using var copy = new MemoryStream();
        await stream.CopyToAsync(copy, Cancel);
        return copy.ToArray();
    }

    [Theory]
    [InlineData(TarEntryFormat.Pax)]
    [InlineData(TarEntryFormat.Gnu)]
    [InlineData(TarEntryFormat.Ustar)]
    public async Task Streams_the_first_file_and_reports_its_header(TarEntryFormat format)
    {
        byte[] content = [.. Enumerable.Range(0, 5000).Select(i => (byte)i)];
        var archive = Archive(format, File(format, "dump.sql", content, 999, 999), File(format, "other", [1, 2, 3]));

        var file = await ArchiveUnwrap.ReadFirstFileAsync(archive, Cancel);

        Assert.Equal("dump.sql", file.Header.Name);
        Assert.Equal(5000, file.Header.Size);
        Assert.Equal(999, file.Header.Uid);
        Assert.Equal(_mtime.ToUnixTimeMilliseconds(), file.Header.MtimeUnixMs);
        Assert.Equal(0b110_100_000, file.Header.Mode);
        Assert.Equal(content, await ReadAllAsync(file.Body));
    }

    [Fact]
    public async Task The_body_ends_at_the_entrys_size_whatever_follows()
    {
        var archive = Archive(TarEntryFormat.Pax, File(TarEntryFormat.Pax, "a", "hello"u8.ToArray()), File(TarEntryFormat.Pax, "b", new byte[4096]));

        var file = await ArchiveUnwrap.ReadFirstFileAsync(archive, Cancel);

        Assert.Equal("hello"u8.ToArray(), await ReadAllAsync(file.Body));
        Assert.Equal(0, await file.Body.ReadAsync(new byte[16], Cancel));
    }

    [Fact]
    public async Task Reads_a_long_name_from_a_pax_header()
    {
        var name = new string('x', 180) + ".log";

        var file = await ArchiveUnwrap.ReadFirstFileAsync(Archive(TarEntryFormat.Pax, File(TarEntryFormat.Pax, name, [7])), Cancel);

        Assert.Equal(name, file.Header.Name);
        Assert.Equal([7], await ReadAllAsync(file.Body));
    }

    [Fact]
    public async Task Refuses_a_folder()
    {
        var folder = new PaxTarEntry(TarEntryType.Directory, "uploads/");

        var refused = await Assert.ThrowsAsync<FileOperationException>(() =>
            ArchiveUnwrap.ReadFirstFileAsync(Archive(TarEntryFormat.Pax, folder, File(TarEntryFormat.Pax, "uploads/a", [1])), Cancel));

        Assert.Equal(FileErrorCode.IsDirectory, refused.Code);
    }

    [Theory]
    [InlineData(TarEntryType.SymbolicLink)]
    [InlineData(TarEntryType.HardLink)]
    [InlineData(TarEntryType.Fifo)]
    public async Task Refuses_a_link_or_anything_else_that_is_not_a_file(TarEntryType type)
    {
        var entry = new PaxTarEntry(type, "odd");
        if (type is TarEntryType.SymbolicLink or TarEntryType.HardLink)
        {
            entry.LinkName = "/etc/passwd";
        }

        var refused = await Assert.ThrowsAsync<FileOperationException>(() => ArchiveUnwrap.ReadFirstFileAsync(Archive(TarEntryFormat.Pax, entry), Cancel));

        Assert.Equal(FileErrorCode.Unsupported, refused.Code);
    }

    [Fact]
    public async Task An_empty_archive_is_not_a_file()
    {
        await Assert.ThrowsAsync<InvalidDataException>(() => ArchiveUnwrap.ReadFirstFileAsync(new MemoryStream(new byte[1024]), Cancel));
    }

    [Fact]
    public async Task An_archive_cut_inside_the_body_fails_the_read()
    {
        var whole = Archive(TarEntryFormat.Pax, File(TarEntryFormat.Pax, "big", new byte[4096])).ToArray();
        var cut = new MemoryStream(whole[..(whole.Length - 1024 - 2048)]);

        var file = await ArchiveUnwrap.ReadFirstFileAsync(cut, Cancel);

        await Assert.ThrowsAsync<EndOfStreamException>(() => ReadAllAsync(file.Body));
    }
}
