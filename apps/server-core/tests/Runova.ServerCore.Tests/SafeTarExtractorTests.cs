using System.Formats.Tar;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using Runova.ServerCore.Uploads;

namespace Runova.ServerCore.Tests;

/// <summary>
/// Build contexts arrive as .tar.gz uploads and the core unpacks them as root, so anything in an
/// archive that could write outside the stack folder, create a device, or fill the disk is refused
/// before it lands, and a refused archive leaves nothing behind. System.Formats.Tar writes names
/// and link targets exactly as given, which is what lets these tests build the hostile archives.
/// </summary>
public sealed class SafeTarExtractorTests : IDisposable
{
    private readonly string _workspace = TestFolders.Create("tar");
    private readonly string _destination;

    public SafeTarExtractorTests()
    {
        Directory.CreateDirectory(_workspace);
        _destination = Path.Combine(_workspace, "stack");
    }

    [Fact]
    public async Task A_build_context_unpacks_into_a_new_folder()
    {
        using var archive = Archive(
            DirectoryEntry("./"),
            FileEntry("./Dockerfile", "FROM alpine\n"),
            DirectoryEntry("./src/"),
            FileEntry("./src/app.js", "console.log('hi')\n"),
            FileEntry("nested//deeper/./notes.txt", "notes"),
            FileEntry("empty.txt", ""));

        var result = await Extract(archive);

        Assert.Equal("FROM alpine\n", await ReadAsync("Dockerfile"));
        Assert.Equal("console.log('hi')\n", await ReadAsync("src/app.js"));
        Assert.Equal("notes", await ReadAsync("nested/deeper/notes.txt"));
        Assert.Equal(string.Empty, await ReadAsync("empty.txt"));
        Assert.Equal(4, result.Files);
        Assert.Equal(3, result.Directories);
        Assert.Equal(0, result.Links);
        Assert.Equal(12 + 18 + 5, result.Bytes);
    }

    [Fact]
    public async Task Files_keep_an_execute_bit_but_never_setuid_or_write_access_for_others()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "Unix file modes");
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        var script = FileEntry("run.sh", "#!/bin/sh\n");
        script.Mode = (UnixFileMode)0b111_111_111_111;
        var data = FileEntry("data.txt", "x");
        data.Mode = (UnixFileMode)0b000_110_110_110;
        var folder = DirectoryEntry("open");
        folder.Mode = (UnixFileMode)0b000_111_111_111;
        using var archive = Archive(script, data, folder);

        await Extract(archive);

        const UnixFileMode executable = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute |
            UnixFileMode.GroupRead | UnixFileMode.GroupExecute | UnixFileMode.OtherRead | UnixFileMode.OtherExecute;
        const UnixFileMode readable = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead |
            UnixFileMode.OtherRead;
        Assert.Equal(executable, File.GetUnixFileMode(Path.Combine(_destination, "run.sh")));
        Assert.Equal(readable, File.GetUnixFileMode(Path.Combine(_destination, "data.txt")));
        Assert.Equal(executable, File.GetUnixFileMode(Path.Combine(_destination, "open")));
    }

    [Theory]
    [InlineData("../evil.txt")]
    [InlineData("safe/../../evil.txt")]
    [InlineData("safe/../inside-but-still-refused.txt")]
    [InlineData("..")]
    public async Task Paths_that_climb_with_dot_dot_are_refused(string name)
    {
        using var archive = Archive(FileEntry("fine.txt"), FileEntry(name, "pwned"));

        var reason = await RejectedAsync(archive);

        Assert.Contains("..", reason, StringComparison.Ordinal);
        Assert.False(File.Exists(Path.Combine(_workspace, "evil.txt")));
    }

    [Theory]
    [InlineData("/etc/cron.d/evil")]
    [InlineData("//etc/evil")]
    [InlineData("C:/Windows/evil.txt")]
    public async Task Absolute_paths_are_refused(string name)
    {
        using var archive = Archive(FileEntry(name, "pwned"));

        var reason = await RejectedAsync(archive);

        Assert.Contains("absolute", reason, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("..\\evil.txt")]
    [InlineData("folder\\file.txt")]
    public async Task Backslashes_are_refused_because_windows_reads_them_as_folders(string name)
    {
        using var archive = Archive(FileEntry(name));

        var reason = await RejectedAsync(archive);

        Assert.Contains("backslash", reason, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("line\nbreak.txt")]
    [InlineData("bell\u0007.txt")]
    [InlineData("stream.txt:hidden")]
    public async Task Names_with_control_characters_or_colons_are_refused(string name)
    {
        using var archive = Archive(FileEntry(name));

        var reason = await RejectedAsync(archive);

        Assert.DoesNotContain('\n', reason);
        Assert.DoesNotContain('\u0007', reason);
    }

    [Theory]
    [InlineData("/etc")]
    [InlineData("../../outside")]
    [InlineData("x/../../../outside")]
    [InlineData("C:/Windows")]
    public async Task A_link_pointing_outside_the_folder_is_refused(string target)
    {
        using var archive = Archive(DirectoryEntry("sub"), SymlinkEntry("sub/link", target));

        var reason = await RejectedAsync(archive);

        Assert.Contains("link", reason, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_link_may_point_one_level_up_while_it_stays_inside()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "Creating symbolic links on Windows needs Developer Mode");
        using var archive = Archive(DirectoryEntry("sub"), FileEntry("top.txt", "top"), SymlinkEntry("sub/link", "../top.txt"));

        await Extract(archive);

        Assert.Equal("top", await ReadAsync("sub/link"));
    }

    [Fact]
    public async Task A_chain_of_links_that_climbs_out_is_refused_even_when_each_looks_inside()
    {
        // "d/up" points at the stack folder itself, which is fine on its own. "hop" then goes
        // through it and up once more: spelled out, "d/up/.." looks like "d", but the kernel
        // follows "d/up" first and lands above the folder.
        using var archive = Archive(DirectoryEntry("d"), SymlinkEntry("d/up", ".."), SymlinkEntry("hop", "d/up/.."));

        var reason = await RejectedAsync(archive);

        Assert.Contains("outside", reason, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Links_that_loop_are_refused()
    {
        using var archive = Archive(SymlinkEntry("a", "b/x"), SymlinkEntry("b", "a"));

        var reason = await RejectedAsync(archive);

        Assert.Contains("loop", reason, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Nothing_is_written_through_a_link()
    {
        using var archive = Archive(
            DirectoryEntry("real"),
            SymlinkEntry("shortcut", "real"),
            FileEntry("shortcut/planted.txt", "pwned"));

        var reason = await RejectedAsync(archive);

        Assert.Contains("through the link", reason, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Links_that_stay_inside_are_created()
    {
        Assert.SkipWhen(OperatingSystem.IsWindows(), "Creating symbolic links on Windows needs Developer Mode");
        using var archive = Archive(
            DirectoryEntry("app"),
            FileEntry("app/config.json", "{}"),
            SymlinkEntry("current", "app"),
            SymlinkEntry("app/settings.json", "config.json"),
            SymlinkEntry("app/back", "../app/config.json"));

        var result = await Extract(archive);

        Assert.Equal(3, result.Links);
        Assert.Equal("app", new FileInfo(Path.Combine(_destination, "current")).LinkTarget);
        Assert.Equal("{}", await ReadAsync("current/settings.json"));
        Assert.Equal("{}", await ReadAsync("app/back"));
    }

    [Fact]
    public async Task A_hard_link_becomes_a_copy_of_the_earlier_file()
    {
        using var archive = Archive(FileEntry("original.txt", "same bytes"), HardLinkEntry("copy.txt", "./original.txt"));

        var result = await Extract(archive);

        Assert.Equal("same bytes", await ReadAsync("copy.txt"));
        Assert.Equal(2, result.Files);
        Assert.Equal(20, result.Bytes);
    }

    [Theory]
    [InlineData("../outside.txt")]
    [InlineData("/etc/shadow")]
    [InlineData("not-in-the-archive.txt")]
    [InlineData("folder")]
    public async Task A_hard_link_to_anything_but_an_earlier_file_inside_is_refused(string target)
    {
        using var archive = Archive(DirectoryEntry("folder"), HardLinkEntry("link", target));

        await RejectedAsync(archive);
    }

    [Fact]
    public async Task Hard_links_count_toward_the_size_cap_so_they_cannot_multiply_one_big_file()
    {
        var entries = new List<TarEntry> { FileEntry("big.bin", new string('x', 600)) };
        entries.AddRange(Enumerable.Range(0, 5).Select(i => HardLinkEntry($"copy-{i}.bin", "big.bin")));
        using var archive = Archive([.. entries]);

        var reason = await RejectedAsync(archive, new TarExtractionLimits { MaxTotalBytes = 1000 });

        Assert.Contains("larger than", reason, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(TarEntryType.CharacterDevice)]
    [InlineData(TarEntryType.BlockDevice)]
    [InlineData(TarEntryType.Fifo)]
    public async Task Devices_and_pipes_are_refused(TarEntryType type)
    {
        var special = new PaxTarEntry(type, "special");
        if (type != TarEntryType.Fifo)
        {
            special.DeviceMajor = 1;
            special.DeviceMinor = 3;
        }

        using var archive = Archive(special);

        var reason = await RejectedAsync(archive);

        Assert.Contains("never unpacked", reason, StringComparison.Ordinal);
    }

    [Fact]
    public async Task An_entry_that_appears_twice_is_refused()
    {
        using var archive = Archive(FileEntry("config.json", "{}"), FileEntry("./config.json", "{\"evil\":true}"));

        var reason = await RejectedAsync(archive);

        Assert.Contains("twice", reason, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_folder_entry_may_repeat_a_folder_that_already_exists()
    {
        using var archive = Archive(FileEntry("src/a.txt"), DirectoryEntry("src"), DirectoryEntry("src/"));

        var result = await Extract(archive);

        Assert.Equal(1, result.Files);
    }

    [Fact]
    public async Task Nothing_goes_inside_a_file()
    {
        using var archive = Archive(FileEntry("plain"), FileEntry("plain/inner.txt"));

        var reason = await RejectedAsync(archive);

        Assert.Contains("inside the file", reason, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Too_many_entries_are_refused()
    {
        using var archive = Archive([.. Enumerable.Range(0, 11).Select(i => FileEntry($"file-{i}.txt"))]);

        var reason = await RejectedAsync(archive, new TarExtractionLimits { MaxEntries = 10 });

        Assert.Contains("more than 10 entries", reason, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Paths_that_are_too_deep_or_too_long_are_refused()
    {
        var limits = new TarExtractionLimits { MaxDepth = 4 };

        using var deep = Archive(FileEntry("a/b/c/d/e.txt"));
        Assert.Contains("deep", await RejectedAsync(deep, limits), StringComparison.Ordinal);

        using var longName = Archive(FileEntry(new string('n', 256)));
        Assert.Contains("255", await RejectedAsync(longName), StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_decompression_bomb_stops_at_the_first_header_that_passes_the_cap()
    {
        // 256 MB of zeros compresses to a few hundred KB; its header alone says it is too big.
        using var archive = Archive(new PaxTarEntry(TarEntryType.RegularFile, "zeros.bin")
        {
            DataStream = new ZeroStream(256L * 1024 * 1024),
        });
        using var counted = new CountingStream(archive);

        var reason = await RejectedAsync(counted, new TarExtractionLimits { MaxTotalBytes = 1024 * 1024 });

        Assert.Contains("larger than", reason, StringComparison.Ordinal);
        Assert.True(counted.BytesRead < archive.Length / 4, $"read {counted.BytesRead} of {archive.Length} bytes");
    }

    [Fact]
    public async Task Many_small_files_stop_as_soon_as_their_total_passes_the_cap()
    {
        using var archive = Archive(
            [.. Enumerable.Range(0, 20).Select(i => BinaryEntry($"part-{i}.bin", RandomNumberGenerator.GetBytes(100 * 1024)))]);
        using var counted = new CountingStream(archive);

        var reason = await RejectedAsync(counted, new TarExtractionLimits { MaxTotalBytes = 1024 * 1024 });

        Assert.Contains("larger than", reason, StringComparison.Ordinal);
        Assert.True(counted.BytesRead < archive.Length * 3 / 4, $"read {counted.BytesRead} of {archive.Length} bytes");
    }

    [Fact]
    public async Task An_oversized_extended_header_is_refused_before_it_is_read_into_memory()
    {
        var attributes = new Dictionary<string, string> { ["comment"] = new string('a', 4 * 1024 * 1024) };
        using var archive = Archive(new PaxTarEntry(TarEntryType.RegularFile, "small.txt", attributes)
        {
            DataStream = new MemoryStream(Encoding.UTF8.GetBytes("small")),
        });

        var reason = await RejectedAsync(archive, new TarExtractionLimits { MaxTotalBytes = 1024 * 1024, MaxEntries = 10 });

        Assert.Contains("larger than", reason, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData('x')]
    [InlineData('g')]
    [InlineData('L')]
    [InlineData('K')]
    public async Task A_metadata_header_claiming_gigabytes_is_refused_before_anything_is_allocated(char type)
    {
        // System.Formats.Tar's own reader would rent a buffer this size before reading a byte.
        using var archive = Gzip(RawHeader("././@LongLink", type, 1L << 30));

        var reason = await RejectedAsync(archive);

        Assert.Contains("extended header of 1 GB", reason, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(TarEntryFormat.V7)]
    [InlineData(TarEntryFormat.Ustar)]
    [InlineData(TarEntryFormat.Pax)]
    [InlineData(TarEntryFormat.Gnu)]
    public async Task Archives_in_every_common_tar_format_unpack(TarEntryFormat format)
    {
        // Past 100 characters, ustar splits a path into prefix and name, PAX writes an extended
        // header and GNU a long-name entry. V7 has none of these, so it keeps to short names.
        var folder = format == TarEntryFormat.V7 ? "short" : string.Join('/', Enumerable.Repeat("a-long-folder-name", 8));
        var deep = $"{folder}/deep.txt";
        var linkTarget = format is TarEntryFormat.Pax or TarEntryFormat.Gnu ? deep : "top.txt";
        using var archive = Archive(
            FormatEntry(format, TarEntryType.Directory, folder),
            FormatEntry(format, TarEntryType.RegularFile, deep, "deep"),
            FormatEntry(format, TarEntryType.RegularFile, "top.txt", "top"),
            FormatEntry(format, TarEntryType.HardLink, "copy.txt", linkTarget: linkTarget));

        var result = await Extract(archive);

        Assert.Equal("deep", await ReadAsync(deep));
        Assert.Equal("top", await ReadAsync("top.txt"));
        Assert.Equal(format is TarEntryFormat.Pax or TarEntryFormat.Gnu ? "deep" : "top", await ReadAsync("copy.txt"));
        Assert.Equal(3, result.Files);
    }

    [Fact]
    public async Task A_header_whose_checksum_does_not_add_up_is_refused()
    {
        using var tar = PlainTar(FileEntry("a.txt"));
        var bytes = tar.ToArray();
        bytes[0] ^= 0x01;

        var reason = await RejectedAsync(Gzip(bytes));

        Assert.Contains("checksum", reason, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Anything_but_a_gzipped_tarball_is_refused(bool plainTar)
    {
        using var archive = plainTar ? PlainTar(FileEntry("a.txt")) : new MemoryStream(Encoding.UTF8.GetBytes("not an archive"));

        var reason = await RejectedAsync(archive);

        Assert.Contains(".tar.gz", reason, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_truncated_archive_is_refused()
    {
        using var whole = Archive(
            BinaryEntry("a.bin", RandomNumberGenerator.GetBytes(10_000)),
            BinaryEntry("b.bin", RandomNumberGenerator.GetBytes(10_000)));
        using var truncated = new MemoryStream(whole.ToArray()[..(int)(whole.Length / 2)]);

        await RejectedAsync(truncated);
    }

    [Fact]
    public async Task It_only_unpacks_into_a_folder_that_does_not_exist_yet()
    {
        Directory.CreateDirectory(_destination);
        await File.WriteAllTextAsync(Path.Combine(_destination, "keep.txt"), "mine", TestContext.Current.CancellationToken);
        using var archive = Archive(FileEntry("a.txt"));

        await Assert.ThrowsAsync<IOException>(() => Extract(archive));

        Assert.True(File.Exists(Path.Combine(_destination, "keep.txt")));
    }

    [Fact]
    public async Task Cancelling_leaves_nothing_behind()
    {
        using var archive = Archive(FileEntry("a.txt"));
        using var cancelled = new CancellationTokenSource();
        await cancelled.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => SafeTarExtractor.ExtractAsync(archive, _destination, TarExtractionLimits.Default, cancelled.Token));

        Assert.False(Directory.Exists(_destination));
    }

    public void Dispose()
    {
        TestFolders.Delete(_workspace);
    }

    private Task<TarExtractionResult> Extract(Stream archive, TarExtractionLimits? limits = null) =>
        SafeTarExtractor.ExtractAsync(
            archive,
            _destination,
            limits ?? TarExtractionLimits.Default,
            TestContext.Current.CancellationToken);

    private async Task<string> RejectedAsync(Stream archive, TarExtractionLimits? limits = null)
    {
        var error = await Assert.ThrowsAsync<ArchiveRejectedException>(() => Extract(archive, limits));
        Assert.False(Directory.Exists(_destination), "a refused archive leaves nothing behind");
        Assert.False(string.IsNullOrWhiteSpace(error.Message));
        return error.Message;
    }

    private Task<string> ReadAsync(string relative) =>
        File.ReadAllTextAsync(Path.Combine(_destination, relative), TestContext.Current.CancellationToken);

    private static MemoryStream Archive(params TarEntry[] entries)
    {
        var archive = new MemoryStream();
        using (var gzip = new GZipStream(archive, CompressionLevel.Fastest, leaveOpen: true))
        using (var writer = new TarWriter(gzip, TarEntryFormat.Pax, leaveOpen: true))
        {
            foreach (var entry in entries)
            {
                writer.WriteEntry(entry);
            }
        }

        archive.Position = 0;
        return archive;
    }

    private static MemoryStream PlainTar(params TarEntry[] entries)
    {
        var archive = new MemoryStream();
        using (var writer = new TarWriter(archive, TarEntryFormat.Pax, leaveOpen: true))
        {
            foreach (var entry in entries)
            {
                writer.WriteEntry(entry);
            }
        }

        archive.Position = 0;
        return archive;
    }

    private static MemoryStream Gzip(byte[] tar)
    {
        var archive = new MemoryStream();
        using (var gzip = new GZipStream(archive, CompressionLevel.Fastest, leaveOpen: true))
        {
            gzip.Write(tar);
        }

        archive.Position = 0;
        return archive;
    }

    /// <summary>A ustar header written by hand, for sizes no tar program would ever write.</summary>
    private static byte[] RawHeader(string name, char type, long size)
    {
        var block = new byte[512];
        Encoding.ASCII.GetBytes(name).CopyTo(block, 0);
        Encoding.ASCII.GetBytes("0000644\0").CopyTo(block, 100);
        Encoding.ASCII.GetBytes("0000000\0").CopyTo(block, 108);
        Encoding.ASCII.GetBytes("0000000\0").CopyTo(block, 116);
        Encoding.ASCII.GetBytes(Convert.ToString(size, 8).PadLeft(11, '0') + "\0").CopyTo(block, 124);
        Encoding.ASCII.GetBytes("00000000000\0").CopyTo(block, 136);
        block[156] = (byte)type;
        Encoding.ASCII.GetBytes("ustar\0" + "00").CopyTo(block, 257);
        "        "u8.CopyTo(block.AsSpan(148));
        var sum = block.Sum(b => (int)b);
        Encoding.ASCII.GetBytes(Convert.ToString(sum, 8).PadLeft(6, '0') + "\0 ").CopyTo(block, 148);
        return block;
    }

    private static TarEntry FormatEntry(
        TarEntryFormat format,
        TarEntryType type,
        string name,
        string? content = null,
        string? linkTarget = null)
    {
        TarEntry entry = format switch
        {
            TarEntryFormat.V7 => new V7TarEntry(type == TarEntryType.RegularFile ? TarEntryType.V7RegularFile : type, name),
            TarEntryFormat.Ustar => new UstarTarEntry(type, name),
            TarEntryFormat.Gnu => new GnuTarEntry(type, name),
            _ => new PaxTarEntry(type, name),
        };
        if (content is not null)
        {
            entry.DataStream = new MemoryStream(Encoding.UTF8.GetBytes(content));
        }

        if (linkTarget is not null)
        {
            entry.LinkName = linkTarget;
        }

        return entry;
    }

    private static PaxTarEntry FileEntry(string name, string content = "hello") =>
        BinaryEntry(name, Encoding.UTF8.GetBytes(content));

    private static PaxTarEntry BinaryEntry(string name, byte[] content) =>
        new(TarEntryType.RegularFile, name) { DataStream = new MemoryStream(content) };

    private static PaxTarEntry DirectoryEntry(string name) => new(TarEntryType.Directory, name);

    private static PaxTarEntry SymlinkEntry(string name, string target) =>
        new(TarEntryType.SymbolicLink, name) { LinkName = target };

    private static PaxTarEntry HardLinkEntry(string name, string target) =>
        new(TarEntryType.HardLink, name) { LinkName = target };

    /// <summary>A seekable stream of zeros, so a huge entry can be written without holding it.</summary>
    private sealed class ZeroStream(long length) : Stream
    {
        public override bool CanRead => true;

        public override bool CanSeek => true;

        public override bool CanWrite => false;

        public override long Length => length;

        public override long Position { get; set; }

        public override int Read(byte[] buffer, int offset, int count)
        {
            var available = (int)Math.Min(count, Math.Max(0, length - Position));
            Array.Clear(buffer, offset, available);
            Position += available;
            return available;
        }

        public override long Seek(long offset, SeekOrigin origin)
        {
            Position = origin switch
            {
                SeekOrigin.Begin => offset,
                SeekOrigin.Current => Position + offset,
                _ => length + offset,
            };
            return Position;
        }

        public override void Flush()
        {
        }

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    /// <summary>Counts what the extractor actually reads, to show it stopped early.</summary>
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

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void Flush()
        {
        }

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
