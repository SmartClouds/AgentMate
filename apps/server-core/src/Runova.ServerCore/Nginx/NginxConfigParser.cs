using System.Text;

namespace Runova.ServerCore.Nginx;

/// <summary>One directive as nginx reads it: its name, its unquoted arguments and, for a block, what is inside.</summary>
/// <param name="Line">The line the directive's name starts on, counted from 1.</param>
internal sealed record NginxDirective(string Name, IReadOnlyList<string> Arguments, int Line, IReadOnlyList<NginxDirective>? Block);

/// <summary>Text nginx itself would refuse to load, with the line and wording nginx would report.</summary>
internal sealed class NginxSyntaxException(int line, string reason) : Exception($"Line {line}: {reason}")
{
    public int Line { get; } = line;

    public string Reason { get; } = reason;
}

/// <summary>
/// Reads nginx configuration text into directives the way nginx does. The tokenizer is a port of
/// nginx's own <c>ngx_conf_read_token</c> (src/core/ngx_conf_file.c), quirks included: a quote only
/// opens a string at the start of a word, <c>#</c> only starts a comment there too, a backslash
/// escapes the next character (and <c>\n</c>, <c>\r</c>, <c>\t</c> decode to control characters),
/// a brace right after <c>$</c> belongs to the variable, and a closing brace in the middle of a word
/// is just a character. Reading snippets any other way would let a directive hide from the checks
/// that run over the result.
/// </summary>
internal static class NginxConfigParser
{
    /// <summary>Deeper nesting than any sensible snippet needs, and far below anything that could exhaust a stack.</summary>
    public const int MaxDepth = 8;

    public static IReadOnlyList<NginxDirective> Parse(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        var reader = new Reader(text);
        return ParseBlock(reader, depth: 0);
    }

    private static List<NginxDirective> ParseBlock(Reader reader, int depth)
    {
        var directives = new List<NginxDirective>();
        while (true)
        {
            var (end, words, line) = reader.ReadStatement();
            switch (end)
            {
                case StatementEnd.EndOfText when depth > 0:
                    throw new NginxSyntaxException(reader.Line, "unexpected end of file, expecting \"}\"");
                case StatementEnd.EndOfText:
                    return directives;
                case StatementEnd.BlockEnd when depth == 0:
                    throw new NginxSyntaxException(reader.Line, "unexpected \"}\"");
                case StatementEnd.BlockEnd:
                    return directives;
                case StatementEnd.Semicolon:
                    directives.Add(new NginxDirective(words[0], words[1..], line, null));
                    break;
                case StatementEnd.BlockStart:
                    if (depth + 1 > MaxDepth)
                    {
                        throw new NginxSyntaxException(
                            reader.Line,
                            $"blocks are nested more than {MaxDepth} deep");
                    }

                    var block = ParseBlock(reader, depth + 1);
                    directives.Add(new NginxDirective(words[0], words[1..], line, block));
                    break;
                default:
                    throw new InvalidOperationException($"Unknown statement end {end}.");
            }
        }
    }

    private enum StatementEnd
    {
        Semicolon,
        BlockStart,
        BlockEnd,
        EndOfText,
    }

    /// <summary>The tokenizer. Variable names and control flow follow nginx's C code closely on purpose.</summary>
    private sealed class Reader(string text)
    {
        private int _position;

        public int Line { get; private set; } = 1;

        public (StatementEnd End, List<string> Words, int Line) ReadStatement()
        {
            var words = new List<string>();
            var needSpace = false;
            var lastSpace = true;
            var sharpComment = false;
            var variable = false;
            var quoted = false;
            var singleQuoted = false;
            var doubleQuoted = false;
            var start = _position;
            var firstLine = 0;

            while (true)
            {
                if (_position >= text.Length)
                {
                    if (words.Count > 0 || !lastSpace)
                    {
                        throw new NginxSyntaxException(Line, "unexpected end of file, expecting \";\" or \"}\"");
                    }

                    return (StatementEnd.EndOfText, words, Line);
                }

                var ch = text[_position++];

                if (ch == '\n')
                {
                    Line++;
                    sharpComment = false;
                }

                if (sharpComment)
                {
                    continue;
                }

                if (quoted)
                {
                    quoted = false;
                    continue;
                }

                if (needSpace)
                {
                    if (IsSpace(ch))
                    {
                        lastSpace = true;
                        needSpace = false;
                        continue;
                    }

                    if (ch == ';')
                    {
                        return (StatementEnd.Semicolon, words, firstLine);
                    }

                    if (ch == '{')
                    {
                        return (StatementEnd.BlockStart, words, firstLine);
                    }

                    if (ch == ')')
                    {
                        lastSpace = true;
                        needSpace = false;
                    }
                    else
                    {
                        throw new NginxSyntaxException(Line, $"unexpected \"{ch}\"");
                    }
                }

                if (lastSpace)
                {
                    start = _position - 1;

                    if (IsSpace(ch))
                    {
                        continue;
                    }

                    if (words.Count == 0 && ch is not (';' or '{' or '}' or '#'))
                    {
                        firstLine = Line;
                    }

                    switch (ch)
                    {
                        case ';':
                        case '{':
                            if (words.Count == 0)
                            {
                                throw new NginxSyntaxException(Line, $"unexpected \"{ch}\"");
                            }

                            return (ch == '{' ? StatementEnd.BlockStart : StatementEnd.Semicolon, words, firstLine);

                        case '}':
                            if (words.Count != 0)
                            {
                                throw new NginxSyntaxException(Line, "unexpected \"}\"");
                            }

                            return (StatementEnd.BlockEnd, words, Line);

                        case '#':
                            sharpComment = true;
                            continue;

                        case '\\':
                            quoted = true;
                            lastSpace = false;
                            continue;

                        case '"':
                            start++;
                            doubleQuoted = true;
                            lastSpace = false;
                            continue;

                        case '\'':
                            start++;
                            singleQuoted = true;
                            lastSpace = false;
                            continue;

                        case '$':
                            variable = true;
                            lastSpace = false;
                            continue;

                        default:
                            lastSpace = false;
                            break;
                    }
                }
                else
                {
                    if (ch == '{' && variable)
                    {
                        continue;
                    }

                    variable = false;

                    if (ch == '\\')
                    {
                        quoted = true;
                        continue;
                    }

                    if (ch == '$')
                    {
                        variable = true;
                        continue;
                    }

                    var found = false;
                    if (doubleQuoted)
                    {
                        if (ch == '"')
                        {
                            doubleQuoted = false;
                            needSpace = true;
                            found = true;
                        }
                    }
                    else if (singleQuoted)
                    {
                        if (ch == '\'')
                        {
                            singleQuoted = false;
                            needSpace = true;
                            found = true;
                        }
                    }
                    else if (IsSpace(ch) || ch == ';' || ch == '{')
                    {
                        lastSpace = true;
                        found = true;
                    }

                    if (found)
                    {
                        words.Add(Unescape(text, start, _position - 1));

                        if (ch == ';')
                        {
                            return (StatementEnd.Semicolon, words, firstLine);
                        }

                        if (ch == '{')
                        {
                            return (StatementEnd.BlockStart, words, firstLine);
                        }
                    }
                }
            }
        }

        private static bool IsSpace(char ch) => ch is ' ' or '\t' or '\r' or '\n';

        /// <summary>nginx's copy loop: <c>\"</c>, <c>\'</c> and <c>\\</c> lose the backslash, <c>\t</c>, <c>\r</c> and <c>\n</c> decode, anything else stays as written.</summary>
        private static string Unescape(string text, int start, int end)
        {
            var word = new StringBuilder(end - start);
            var index = start;
            while (index < end)
            {
                if (text[index] == '\\' && index + 1 < end)
                {
                    switch (text[index + 1])
                    {
                        case '"':
                        case '\'':
                        case '\\':
                            index++;
                            break;
                        case 't':
                            word.Append('\t');
                            index += 2;
                            continue;
                        case 'r':
                            word.Append('\r');
                            index += 2;
                            continue;
                        case 'n':
                            word.Append('\n');
                            index += 2;
                            continue;
                        default:
                            break;
                    }
                }

                word.Append(text[index++]);
            }

            return word.ToString();
        }
    }
}
