using System.Globalization;
using System.Text.RegularExpressions;

namespace Runova.ServerCore.Docker;

/// <summary>
/// Docker's timestamps: RFC 3339 in UTC with up to nine fractional digits, which is more than
/// DateTimeOffset parses. Log lines and events are ordered and resumed by these to the nanosecond.
/// </summary>
internal static partial class DockerTime
{
    /// <summary>Unix nanoseconds for an RFC 3339 UTC time; false for anything else.</summary>
    public static bool TryParseNanoseconds(string? text, out long unixNanoseconds)
    {
        unixNanoseconds = 0;
        if (text is not { Length: >= 20 and <= 40 })
        {
            return false;
        }

        var match = Rfc3339().Match(text);
        if (!match.Success
            || !DateTimeOffset.TryParseExact(
                match.Groups["seconds"].Value,
                "yyyy-MM-dd'T'HH:mm:ss",
                CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal,
                out var seconds))
        {
            return false;
        }

        var fraction = match.Groups["fraction"].Value.PadRight(9, '0');
        var offset = match.Groups["offset"].Value;
        var offsetSeconds = 0L;
        if (offset != "Z")
        {
            var sign = offset[0] == '-' ? -1 : 1;
            offsetSeconds = sign * ((long.Parse(offset[1..3], CultureInfo.InvariantCulture) * 3600) + (long.Parse(offset[4..6], CultureInfo.InvariantCulture) * 60));
        }

        unixNanoseconds = ((seconds.ToUnixTimeSeconds() - offsetSeconds) * 1_000_000_000) + long.Parse(fraction, CultureInfo.InvariantCulture);
        return true;
    }

    /// <summary>Unix milliseconds, or null for an unset time (Docker writes 0001-01-01 for "never").</summary>
    public static long? ToUnixMs(string? text) =>
        TryParseNanoseconds(text, out var nanoseconds) && nanoseconds > 0 ? nanoseconds / 1_000_000 : null;

    /// <summary>`seconds.nanoseconds`, the form the engine's since and until parameters take.</summary>
    public static string ToEngineTime(long unixNanoseconds) =>
        string.Create(CultureInfo.InvariantCulture, $"{unixNanoseconds / 1_000_000_000}.{unixNanoseconds % 1_000_000_000:D9}");

    [GeneratedRegex(
        @"^(?<seconds>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(?<fraction>\d{1,9}))?(?<offset>Z|[+-]\d{2}:\d{2})$",
        RegexOptions.CultureInvariant)]
    private static partial Regex Rfc3339();
}
