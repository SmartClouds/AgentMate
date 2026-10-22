using System.Globalization;
using System.Text;
using AgentMate.ServerCore.Contracts;

namespace AgentMate.ServerCore.Files;

/// <param name="Incomplete">The output stopped inside a record (it hit the output cap); the whole records before it are kept.</param>
internal sealed record ParsedListing(IReadOnlyList<FileEntry> Entries, bool Incomplete);

/// <summary>
/// Reads what <see cref="FileScripts.List"/> prints. Each record is `stat -c "%s %f %Y %u %g"`
/// and a newline; for a link, "d", "f" or "b" (a folder, a file or nothing at the other end), a
/// newline, the target and a NUL; then the name and a NUL. `%f` is the raw mode in hex, which
/// busybox and coreutils both print the same way. Names are bytes up to the NUL, so spaces,
/// newlines and any other character survive; bytes that are not UTF-8 are shown as U+FFFD.
/// </summary>
internal static class ListingParser
{
    public const int TypeMask = 0xF000;
    public const int Directory = 0x4000;
    public const int Regular = 0x8000;
    public const int Symlink = 0xA000;

    /// <param name="single">One stat record, which may be "." (the folder itself).</param>
    public static ParsedListing Parse(ReadOnlySpan<byte> output, bool single = false)
    {
        var entries = new List<FileEntry>();
        var rest = output;
        while (!rest.IsEmpty)
        {
            var record = rest;
            var newline = record.IndexOf((byte)'\n');
            if (newline < 0)
            {
                return new ParsedListing(entries, true);
            }

            var (size, mode, mtime, uid, gid) = ParseStat(record[..newline]);
            record = record[(newline + 1)..];

            string? target = null;
            var linkKind = (byte)0;
            if ((mode & TypeMask) == Symlink)
            {
                if (record.Length < 2)
                {
                    return new ParsedListing(entries, true);
                }

                linkKind = record[0];
                if (linkKind is not ((byte)'d' or (byte)'f' or (byte)'b') || record[1] != (byte)'\n')
                {
                    throw Invalid("a link record does not say what it points at");
                }

                record = record[2..];
                var targetEnd = record.IndexOf((byte)0);
                if (targetEnd < 0)
                {
                    return new ParsedListing(entries, true);
                }

                target = Encoding.UTF8.GetString(record[..targetEnd]);
                record = record[(targetEnd + 1)..];
            }

            var nameEnd = record.IndexOf((byte)0);
            if (nameEnd < 0)
            {
                return new ParsedListing(entries, true);
            }

            var name = Encoding.UTF8.GetString(record[..nameEnd]);
            if (name.Length == 0 || name == ".." || (name == "." && !single) || name.Contains('/', StringComparison.Ordinal))
            {
                throw Invalid("a record has no usable name");
            }

            entries.Add(new FileEntry(
                name,
                KindOf(mode),
                size,
                mtime * 1000,
                mode,
                uid,
                gid,
                target,
                LinkIsDirectory: linkKind == (byte)'d',
                BrokenLink: linkKind == (byte)'b'));
            rest = record[(nameEnd + 1)..];
        }

        return new ParsedListing(entries, false);
    }

    public static FileEntryKind KindOf(int mode) => (mode & TypeMask) switch
    {
        Directory => FileEntryKind.Directory,
        Regular => FileEntryKind.File,
        Symlink => FileEntryKind.Symlink,
        _ => FileEntryKind.Other,
    };

    private static (long Size, int Mode, long Mtime, int Uid, int Gid) ParseStat(ReadOnlySpan<byte> line)
    {
        var fields = Encoding.Latin1.GetString(line).Split(' ');
        if (fields.Length != 5)
        {
            throw Invalid("a stat line does not have five fields");
        }

        if (!long.TryParse(fields[0], NumberStyles.None, CultureInfo.InvariantCulture, out var size)
            || !int.TryParse(fields[1], NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out var mode)
            || !long.TryParse(fields[2], NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var mtime)
            || !uint.TryParse(fields[3], NumberStyles.None, CultureInfo.InvariantCulture, out var uid)
            || !uint.TryParse(fields[4], NumberStyles.None, CultureInfo.InvariantCulture, out var gid))
        {
            throw Invalid("a stat line has a field that is not a number");
        }

        // Ids above int.MaxValue (4294967294 for nobody on some systems) keep their bits.
        return (size, mode, mtime, unchecked((int)uid), unchecked((int)gid));
    }

    private static InvalidDataException Invalid(string problem) => new($"The file listing is not what the lister prints: {problem}.");
}
