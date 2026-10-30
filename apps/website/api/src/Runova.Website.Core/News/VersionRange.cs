using System.Globalization;
using System.Text.RegularExpressions;

namespace Runova.Website.Core.News;

/// <summary>
/// The versions of a technology a news item affects, in the contract's grammar: comparator sets
/// joined by <c> || </c>, each a space-separated list of comparators that must all hold, or
/// <c>*</c> for every version. The desktop matcher reads the same grammar.
/// </summary>
public sealed partial class VersionRange
{
    private const int MaxParts = 4;

    private readonly IReadOnlyList<IReadOnlyList<Comparator>> _sets;

    private VersionRange(IReadOnlyList<IReadOnlyList<Comparator>> sets) => _sets = sets;

    public static bool TryParse(string? text, out VersionRange? range)
    {
        range = null;
        if (string.IsNullOrEmpty(text))
        {
            return false;
        }

        var sets = new List<IReadOnlyList<Comparator>>();
        foreach (var set in text.Split(" || "))
        {
            if (set == "*")
            {
                sets.Add([]);
                continue;
            }

            var comparators = new List<Comparator>();
            foreach (var part in set.Split(' '))
            {
                var match = ComparatorPattern().Match(part);
                if (!match.Success)
                {
                    return false;
                }

                comparators.Add(new Comparator(match.Groups["op"].Value, Numbers(match.Groups["version"].Value)!));
            }

            sets.Add(comparators);
        }

        range = new VersionRange(sets);
        return true;
    }

    /// <summary>Whether any comparator set holds for the version. A version with no numeric part never matches.</summary>
    public bool IsSatisfiedBy(string version)
    {
        if (Numbers(version) is not { } numbers)
        {
            return false;
        }

        return _sets.Any(set => set.All(c => c.Holds(numbers)));
    }

    /// <summary>
    /// Up to four leading numeric parts, read until the first character that is not a digit or a
    /// dot, after one leading <c>v</c>; missing parts are 0. Null when there is no numeric part.
    /// </summary>
    private static long[]? Numbers(string version)
    {
        var text = version.StartsWith('v') ? version[1..] : version;
        var end = 0;
        while (end < text.Length && (char.IsAsciiDigit(text[end]) || text[end] == '.'))
        {
            end++;
        }

        var parts = text[..end].Split('.');
        var numbers = new long[MaxParts];
        var read = 0;
        foreach (var part in parts)
        {
            if (read == MaxParts || part.Length == 0 || !long.TryParse(part, NumberStyles.None, CultureInfo.InvariantCulture, out var number))
            {
                break;
            }

            numbers[read++] = number;
        }

        return read == 0 ? null : numbers;
    }

    private static int Compare(long[] left, long[] right)
    {
        for (var i = 0; i < MaxParts; i++)
        {
            var order = left[i].CompareTo(right[i]);
            if (order != 0)
            {
                return order;
            }
        }

        return 0;
    }

    // A comparator's own version is strict: one to four integers, after an optional v.
    [GeneratedRegex(@"^(?<op><=|>=|<|>|=)(?<version>v?\d+(\.\d+){0,3})$")]
    private static partial Regex ComparatorPattern();

    private sealed record Comparator(string Operator, long[] Version)
    {
        public bool Holds(long[] version)
        {
            var order = Compare(version, Version);
            return Operator switch
            {
                "<" => order < 0,
                "<=" => order <= 0,
                ">" => order > 0,
                ">=" => order >= 0,
                _ => order == 0,
            };
        }
    }
}
