using System.Text;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Files;

namespace Runova.ServerCore.Tests.Files;

/// <summary>
/// The lister prints, per entry, `stat -c "%s %f %Y %u %g"` and a newline, then for a link what
/// it points at (d, f or b for broken, a newline, the target and a NUL), then the name and a NUL.
/// Names can hold anything but a slash and a NUL, so they are read as bytes up to the NUL.
/// </summary>
public sealed class ListingParserTests
{
    private const long Mtime = 1_792_628_316;

    /// <summary>One record, written the way the script writes it.</summary>
    private static byte[] Record(string stat, string name, string? link = null, char linkKind = 'f')
    {
        var record = new List<byte>(Encoding.UTF8.GetBytes(stat + "\n"));
        if (link is not null)
        {
            record.AddRange(Encoding.UTF8.GetBytes($"{linkKind}\n{link}"));
            record.Add(0);
        }

        record.AddRange(Encoding.UTF8.GetBytes(name));
        record.Add(0);
        return [.. record];
    }

    private static byte[] Join(params byte[][] records) => [.. records.SelectMany(r => r)];

    [Fact]
    public void Reads_files_and_folders_with_their_mode_size_time_and_owner()
    {
        var output = Join(
            Record($"612 81a4 {Mtime} 0 0", "nginx.conf"),
            Record($"4096 41ed {Mtime} 101 102", "conf.d"));

        var listing = ListingParser.Parse(output);

        Assert.False(listing.Incomplete);
        Assert.Equal(
            [
                new FileEntry("nginx.conf", FileEntryKind.File, 612, Mtime * 1000, 0x81a4, 0, 0),
                new FileEntry("conf.d", FileEntryKind.Directory, 4096, Mtime * 1000, 0x41ed, 101, 102),
            ],
            listing.Entries);
        Assert.Equal(0b110_100_100, listing.Entries[0].Mode & 0x1ff);
    }

    [Theory]
    [InlineData("with space")]
    [InlineData("line\nbreak")]
    [InlineData("trailing\n")]
    [InlineData("ünïcødé 文件.txt")]
    [InlineData(".hidden")]
    [InlineData("-starts-with-a-dash")]
    [InlineData("tab\there")]
    [InlineData("12 81a4 3 4 5")]
    public void Keeps_any_name_whole(string name)
    {
        var listing = ListingParser.Parse(Record($"1 81a4 {Mtime} 0 0", name));

        Assert.Equal(name, Assert.Single(listing.Entries).Name);
    }

    [Fact]
    public void Reads_links_to_folders_to_files_and_to_nothing()
    {
        var output = Join(
            Record($"4 a1ff {Mtime} 0 0", "etc-link", "/etc", 'd'),
            Record($"21 a1ff {Mtime} 0 0", "os-release", "../usr/lib/os-release", 'f'),
            Record($"5 a1ff {Mtime} 0 0", "gone", "/nope", 'b'),
            Record($"12 a1ff {Mtime} 0 0", "odd target", "line\nbreak and space", 'f'));

        var entries = ListingParser.Parse(output).Entries;

        Assert.Equal(new FileEntry("etc-link", FileEntryKind.Symlink, 4, Mtime * 1000, 0xa1ff, 0, 0, "/etc", LinkIsDirectory: true), entries[0]);
        Assert.Equal(new FileEntry("os-release", FileEntryKind.Symlink, 21, Mtime * 1000, 0xa1ff, 0, 0, "../usr/lib/os-release"), entries[1]);
        Assert.Equal(new FileEntry("gone", FileEntryKind.Symlink, 5, Mtime * 1000, 0xa1ff, 0, 0, "/nope", BrokenLink: true), entries[2]);
        Assert.Equal("line\nbreak and space", entries[3].LinkTarget);
    }

    [Theory]
    [InlineData("41ed", FileEntryKind.Directory)]
    [InlineData("81a4", FileEntryKind.File)]
    [InlineData("A1FF", FileEntryKind.Symlink)]
    [InlineData("21b6", FileEntryKind.Other)]
    [InlineData("61b0", FileEntryKind.Other)]
    [InlineData("11a4", FileEntryKind.Other)]
    [InlineData("c1ed", FileEntryKind.Other)]
    [InlineData("41ff", FileEntryKind.Directory)]
    [InlineData("43ff", FileEntryKind.Directory)]
    public void Reads_the_kind_from_the_raw_hex_mode_busybox_and_coreutils_print(string hexMode, FileEntryKind kind)
    {
        var link = kind == FileEntryKind.Symlink ? "x" : null;

        var entry = Assert.Single(ListingParser.Parse(Record($"0 {hexMode} {Mtime} 0 0", "e", link)).Entries);

        Assert.Equal(kind, entry.Kind);
        Assert.Equal(Convert.ToInt32(hexMode, 16), entry.Mode);
    }

    [Fact]
    public void Reads_the_sticky_and_setuid_bits()
    {
        var entries = ListingParser.Parse(Join(
            Record($"4096 43ff {Mtime} 0 0", "tmp"),
            Record($"55 89ed {Mtime} 0 0", "passwd"))).Entries;

        Assert.Equal(0x200, entries[0].Mode & 0xe00);
        Assert.Equal(0x800, entries[1].Mode & 0xe00);
    }

    [Fact]
    public void Reads_large_sizes_and_ids()
    {
        var entry = Assert.Single(ListingParser.Parse(Record($"53687091200 81a4 {Mtime} 4294967294 65534", "big.img")).Entries);

        Assert.Equal(53_687_091_200, entry.Size);
        Assert.Equal(-2, entry.Uid);
        Assert.Equal(65534, entry.Gid);
    }

    [Fact]
    public void An_empty_folder_is_an_empty_listing()
    {
        var listing = ListingParser.Parse([]);

        Assert.Empty(listing.Entries);
        Assert.False(listing.Incomplete);
    }

    [Fact]
    public void Output_cut_short_keeps_the_whole_records_and_says_so()
    {
        var whole = Join(Record($"1 81a4 {Mtime} 0 0", "a"), Record($"2 81a4 {Mtime} 0 0", "b"));
        var cut = Join(whole, Encoding.UTF8.GetBytes($"3 81a4 {Mtime} 0 0\nhalf-a-na"));

        var listing = ListingParser.Parse(cut);

        Assert.True(listing.Incomplete);
        Assert.Equal(["a", "b"], listing.Entries.Select(e => e.Name));
    }

    [Theory]
    [InlineData("1 81a4 1")]
    [InlineData("1 81a4 1 0 0")]
    [InlineData("1 81a4 1 0 0\nname-without-its-nul")]
    [InlineData("4 a1ff 1 0 0\nd\n/etc")]
    [InlineData("4 a1ff 1 0 0\nd")]
    public void A_record_cut_anywhere_is_incomplete(string partial)
    {
        var listing = ListingParser.Parse(Encoding.UTF8.GetBytes(partial));

        Assert.True(listing.Incomplete);
        Assert.Empty(listing.Entries);
    }

    [Theory]
    [InlineData("x 81a4 1 0 0\nname\0")]
    [InlineData("1 zz 1 0 0\nname\0")]
    [InlineData("1 81a4 1 0\nname\0")]
    [InlineData("1 81a4 1 0 0 9\nname\0")]
    [InlineData("4 a1ff 1 0 0\nq\n/etc\0name\0")]
    [InlineData("1 81a4 1 0 0\n\0")]
    [InlineData("1 81a4 1 0 0\n.\0")]
    [InlineData("1 81a4 1 0 0\na/b\0")]
    public void Output_that_is_not_the_listers_is_refused(string output)
    {
        Assert.Throws<InvalidDataException>(() => ListingParser.Parse(Encoding.UTF8.GetBytes(output)));
    }

    [Fact]
    public void A_single_stat_record_may_be_the_folder_itself()
    {
        var output = Encoding.UTF8.GetBytes($"4096 41ed {Mtime} 0 0\n.\0");

        Assert.Equal(".", Assert.Single(ListingParser.Parse(output, single: true).Entries).Name);
        Assert.Throws<InvalidDataException>(() => ListingParser.Parse(output));
    }

    [Fact]
    public void A_name_that_is_not_utf8_is_shown_with_replacement_characters()
    {
        var output = Join(Encoding.UTF8.GetBytes($"1 81a4 {Mtime} 0 0\n"), [0x6c, 0xe9, 0x6e, 0], []);

        Assert.Equal("l�n", Assert.Single(ListingParser.Parse(output).Entries).Name);
    }
}
