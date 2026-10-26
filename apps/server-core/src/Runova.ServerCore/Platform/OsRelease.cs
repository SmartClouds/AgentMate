using System.Text;
using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.Platform;

/// <summary>
/// /etc/os-release and the systems the core is built and tested for. The matrix is the one the
/// installer checks before it installs anything (desktop `bootstrap/osSupport.ts`); a server that
/// later moves to a release outside it keeps working as best effort, flagged unsupported.
/// </summary>
internal static class OsRelease
{
    public const string Path = "/etc/os-release";

    /// <summary>systemd's fallback when /etc/os-release is missing.</summary>
    public const string FallbackPath = "/usr/lib/os-release";

    private const string SupportedList =
        "Ubuntu 22.04, 24.04 or 26.04, Debian 12 or 13, and RHEL, Rocky, Alma or CentOS Stream 9 or 10";

    /// <summary>By os-release ID. Ubuntu names exact releases (interim ones are not supported).</summary>
    private static readonly Dictionary<string, (OsFamily Family, string[] Versions, bool Exact)> _matrix =
        new(StringComparer.Ordinal)
        {
            ["ubuntu"] = (OsFamily.Debian, ["22.04", "24.04", "26.04"], true),
            ["debian"] = (OsFamily.Debian, ["12", "13"], false),
            ["rhel"] = (OsFamily.Rhel, ["9", "10"], false),
            ["rocky"] = (OsFamily.Rhel, ["9", "10"], false),
            ["almalinux"] = (OsFamily.Rhel, ["9", "10"], false),
            ["centos"] = (OsFamily.Rhel, ["9", "10"], false),
        };

    /// <summary>KEY=value lines; values may be quoted, and double quotes allow backslash escapes.</summary>
    public static IReadOnlyDictionary<string, string> Parse(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        var fields = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var raw in text.Split('\n'))
        {
            var line = raw.Trim();
            if (line.Length == 0 || line.StartsWith('#'))
            {
                continue;
            }

            var equals = line.IndexOf('=', StringComparison.Ordinal);
            if (equals <= 0 || line[..equals].Any(char.IsWhiteSpace))
            {
                continue;
            }

            fields[line[..equals]] = Unquote(line[(equals + 1)..]);
        }

        return fields;
    }

    public static OsInfo Describe(IReadOnlyDictionary<string, string> fields)
    {
        ArgumentNullException.ThrowIfNull(fields);
        var id = fields.GetValueOrDefault("ID", string.Empty).ToLowerInvariant();
        var version = fields.GetValueOrDefault("VERSION_ID", string.Empty);
        var name = fields.GetValueOrDefault("PRETTY_NAME") is { Length: > 0 } pretty
            ? pretty
            : $"{fields.GetValueOrDefault("NAME", id)} {version}".Trim();
        var family = FamilyOf(id, fields.GetValueOrDefault("ID_LIKE", string.Empty));

        if (_matrix.TryGetValue(id, out var entry))
        {
            var major = version.Split('.')[0];
            var matches = entry.Exact ? entry.Versions.Contains(version) : entry.Versions.Contains(major);
            if (matches)
            {
                return new OsInfo(id, version, name, entry.Family, Supported: true);
            }
        }

        var shown = name.Length > 0 ? name : "This operating system";
        return new OsInfo(
            id,
            version,
            name,
            family,
            Supported: false,
            $"{shown} is not supported. The server core runs on {SupportedList}.");
    }

    private static OsFamily FamilyOf(string id, string idLike)
    {
        if (id is "ubuntu" or "debian")
        {
            return OsFamily.Debian;
        }

        if (id is "rhel" or "rocky" or "almalinux" or "centos" or "fedora")
        {
            return OsFamily.Rhel;
        }

        var like = idLike.ToLowerInvariant().Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (like.Any(entry => entry is "debian" or "ubuntu"))
        {
            return OsFamily.Debian;
        }

        return like.Any(entry => entry is "rhel" or "fedora" or "centos") ? OsFamily.Rhel : OsFamily.Unknown;
    }

    private static string Unquote(string value)
    {
        if (value.Length >= 2 && value[0] == '"' && value[^1] == '"')
        {
            var inner = value[1..^1];
            var text = new StringBuilder(inner.Length);
            for (var i = 0; i < inner.Length; i++)
            {
                if (inner[i] == '\\' && i + 1 < inner.Length && inner[i + 1] is '"' or '$' or '`' or '\\')
                {
                    i++;
                }

                text.Append(inner[i]);
            }

            return text.ToString();
        }

        return value.Length >= 2 && value[0] == '\'' && value[^1] == '\'' ? value[1..^1] : value;
    }
}
