using System.Text;

namespace Runova.ServerCore.Nginx;

/// <summary>Setting nginx up for Runova failed in a way the person has to see.</summary>
internal sealed class NginxSetupException(string message) : Exception(message);

/// <summary>
/// Puts Runova's two include lines into nginx.conf, once: one at the end of the http block and
/// one in a top-level stream block (added when there is none). The rest of the file stays exactly
/// as it was. Blocks are found the way nginx reads them, so braces in comments and quoted strings
/// do not count.
/// </summary>
internal static class NginxConfWiring
{
    private const string Note = "# Added by Runova: the sites and proxies it manages.";

    /// <summary>Whether each include is already there, on a line of its own and not commented out.</summary>
    public static (bool Http, bool Stream) IsWired(string text, NginxLayout layout)
    {
        ArgumentNullException.ThrowIfNull(text);
        ArgumentNullException.ThrowIfNull(layout);
        var lines = text.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n').Select(line => line.Trim()).ToList();
        return (lines.Contains(layout.HttpInclude), lines.Contains(layout.StreamInclude));
    }

    /// <exception cref="NginxSetupException">The file has no http block, or its braces do not balance.</exception>
    public static string Wire(string text, NginxLayout layout, bool stream)
    {
        ArgumentNullException.ThrowIfNull(text);
        ArgumentNullException.ThrowIfNull(layout);
        var (httpDone, streamDone) = IsWired(text, layout);
        var blocks = TopLevelBlocks(text);

        if (!httpDone)
        {
            var http = blocks.FirstOrDefault(block => block.Name == "http");
            if (http is null)
            {
                throw new NginxSetupException("nginx.conf has no http block for Runova's sites to go into.");
            }

            text = InsertBefore(text, http.Close, layout.HttpInclude);
            blocks = TopLevelBlocks(text);
        }

        if (stream && !streamDone)
        {
            var existing = blocks.FirstOrDefault(block => block.Name == "stream");
            text = existing is not null
                ? InsertBefore(text, existing.Close, layout.StreamInclude)
                : text.TrimEnd('\n') + $"\n\n{Note}\nstream {{\n    {layout.StreamInclude}\n}}\n";
        }

        return text;
    }

    /// <summary>Puts the line on its own just before the block's closing brace, indented one level.</summary>
    private static string InsertBefore(string text, int close, string line)
    {
        var lineStart = text.LastIndexOf('\n', Math.Max(0, close - 1)) + 1;
        var onlySpaceBefore = text[lineStart..close].All(c => c is ' ' or '\t');
        var builder = new StringBuilder(text.Length + line.Length + Note.Length + 16);
        if (onlySpaceBefore)
        {
            builder.Append(text, 0, lineStart);
        }
        else
        {
            builder.Append(text, 0, close).Append('\n');
        }

        builder.Append("    ").Append(line).Append('\n');
        builder.Append(text, onlySpaceBefore ? lineStart : close, text.Length - (onlySpaceBefore ? lineStart : close));
        return builder.ToString();
    }

    private sealed record Block(string Name, int Open, int Close);

    /// <summary>Top-level blocks with the positions of their braces.</summary>
    private static List<Block> TopLevelBlocks(string text)
    {
        var blocks = new List<Block>();
        var depth = 0;
        var word = new StringBuilder();
        string? firstWord = null;
        var openName = string.Empty;
        var openAt = -1;
        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];
            if (c == '#' && word.Length == 0)
            {
                while (i < text.Length && text[i] != '\n')
                {
                    i++;
                }

                continue;
            }

            if (c is '"' or '\'')
            {
                var quote = c;
                for (i++; i < text.Length && text[i] != quote; i++)
                {
                    if (text[i] == '\\')
                    {
                        i++;
                    }
                }

                word.Append('q');
                continue;
            }

            if (c == '\\')
            {
                i++;
                word.Append('e');
                continue;
            }

            if (char.IsWhiteSpace(c) || c is ';' or '{' or '}')
            {
                if (word.Length > 0)
                {
                    firstWord ??= word.ToString();
                    word.Clear();
                }

                if (c == ';')
                {
                    firstWord = null;
                }
                else if (c == '{')
                {
                    if (depth == 0)
                    {
                        openName = firstWord ?? string.Empty;
                        openAt = i;
                    }

                    depth++;
                    firstWord = null;
                }
                else if (c == '}')
                {
                    depth--;
                    if (depth < 0)
                    {
                        throw new NginxSetupException("nginx.conf has a closing brace with no block to close.");
                    }

                    if (depth == 0)
                    {
                        blocks.Add(new Block(openName, openAt, i));
                    }

                    firstWord = null;
                }

                continue;
            }

            word.Append(c);
        }

        return depth != 0 ? throw new NginxSetupException("nginx.conf has a block that is never closed.") : blocks;
    }
}
