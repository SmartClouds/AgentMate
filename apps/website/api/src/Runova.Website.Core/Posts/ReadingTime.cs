namespace Runova.Website.Core.Posts;

/// <summary>The contract's reading time: the body's word count over 230, rounded up, at least 1.</summary>
public static class ReadingTime
{
    public const int WordsPerMinute = 230;

    public static int Minutes(string markdown) => Math.Max(1, (Words(markdown) + WordsPerMinute - 1) / WordsPerMinute);

    /// <summary>Runs of non-space characters with a letter or digit in them, so a bare <c>##</c> or <c>-</c> is no word.</summary>
    public static int Words(string markdown) =>
        markdown.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries).Count(word => word.Any(char.IsLetterOrDigit));
}
