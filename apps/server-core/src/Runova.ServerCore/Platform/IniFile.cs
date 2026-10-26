namespace Runova.ServerCore.Platform;

/// <summary>
/// Reads and sets one `key = value` in an INI file (dnf-automatic's), leaving comments, order and
/// every other line exactly as they were.
/// </summary>
internal static class IniFile
{
    public static string? Get(string text, string section, string key)
    {
        ArgumentNullException.ThrowIfNull(text);
        var lines = text.Split('\n');
        var (start, end) = SectionRange(lines, section);
        for (var i = start + 1; start >= 0 && i < end; i++)
        {
            if (KeyOf(lines[i]) == key)
            {
                return lines[i][(lines[i].IndexOf('=', StringComparison.Ordinal) + 1)..].Trim();
            }
        }

        return null;
    }

    public static string Set(string text, string section, string key, string value)
    {
        ArgumentNullException.ThrowIfNull(text);
        if (new[] { section, key, value }.Any(part => part.Contains('\n', StringComparison.Ordinal) || part.Contains('\r', StringComparison.Ordinal)))
        {
            throw new ArgumentException("INI sections, keys and values are single lines.");
        }

        var entry = $"{key} = {value}";
        var lines = text.Split('\n').ToList();
        var (start, end) = SectionRange([.. lines], section);
        if (start < 0)
        {
            var prefix = text.Length == 0 ? string.Empty : text.EndsWith('\n') ? text + "\n" : text + "\n\n";
            return $"{prefix}[{section}]\n{entry}\n";
        }

        var last = start;
        for (var i = start + 1; i < end; i++)
        {
            if (KeyOf(lines[i]) == key)
            {
                lines[i] = entry;
                return string.Join('\n', lines);
            }

            if (lines[i].Trim().Length > 0)
            {
                last = i;
            }
        }

        lines.Insert(last + 1, entry);
        return string.Join('\n', lines);
    }

    /// <summary>The header line of the section and the line after its last one; -1 when it is missing.</summary>
    private static (int Start, int End) SectionRange(string[] lines, string section)
    {
        var start = -1;
        for (var i = 0; i < lines.Length; i++)
        {
            var trimmed = lines[i].Trim();
            if (!trimmed.StartsWith('[') || !trimmed.EndsWith(']'))
            {
                continue;
            }

            if (start >= 0)
            {
                return (start, i);
            }

            if (trimmed[1..^1].Trim() == section)
            {
                start = i;
            }
        }

        return (start, lines.Length);
    }

    private static string? KeyOf(string line)
    {
        var trimmed = line.TrimStart();
        if (trimmed.StartsWith('#') || trimmed.StartsWith(';'))
        {
            return null;
        }

        var equals = trimmed.IndexOf('=', StringComparison.Ordinal);
        return equals > 0 ? trimmed[..equals].Trim() : null;
    }
}
