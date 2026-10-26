using System.Text;

namespace Runova.ServerCore.Stacks;

/// <summary>
/// Reads the .env file the app renders for a stack (packages/core/src/deploy/env/composeEnv.ts):
/// comment and blank lines, then KEY="value" lines where the value has `\\`, `\"`, `\n`, `\r`,
/// `\t` and `\0` plus three octal digits as escapes and every `$` doubled. Anything else is
/// refused, so what the core stores is exactly what Compose reads back, and the values it seeds
/// the redactor with are the ones the containers get.
/// </summary>
internal static class ComposeEnvFile
{
    public const int MaxBytes = 1024 * 1024;

    public sealed record Result(IReadOnlyList<KeyValuePair<string, string>> Entries, string? Problem)
    {
        public bool Ok => Problem is null;
    }

    public static Result Parse(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        if (Encoding.UTF8.GetByteCount(text) > MaxBytes)
        {
            return Refuse("The .env file is larger than 1 MB.");
        }

        var entries = new List<KeyValuePair<string, string>>();
        var lines = text.Split('\n');
        for (var index = 0; index < lines.Length; index++)
        {
            var line = lines[index];
            var number = index + 1;
            if (line.Length == 0 || line.StartsWith('#'))
            {
                continue;
            }

            var equals = line.IndexOf('=', StringComparison.Ordinal);
            if (equals <= 0)
            {
                return Refuse($"Line {number} of the .env file is not KEY=\"value\".");
            }

            var key = line[..equals];
            if (!StackRules.IsEnvKey(key))
            {
                return Refuse($"Line {number} of the .env file has a key that can't be used.");
            }

            var value = ReadValue(line[(equals + 1)..]);
            if (value is null)
            {
                return Refuse($"The value of {key} (line {number}) is not written the way Runova writes .env files.");
            }

            entries.Add(new(key, value));
        }

        return new Result(entries, null);
    }

    private static Result Refuse(string problem) => new([], problem);

    private static bool IsOctal(string text, int start) =>
        start + 3 <= text.Length && text.AsSpan(start, 3).IndexOfAnyExceptInRange('0', '7') < 0;

    private static string? ReadValue(string raw)
    {
        if (raw.Length < 2 || raw[0] != '"' || raw[^1] != '"')
        {
            return null;
        }

        var inner = raw[1..^1];
        var value = new StringBuilder(inner.Length);
        for (var i = 0; i < inner.Length; i++)
        {
            var c = inner[i];
            switch (c)
            {
                case '"':
                    return null;
                case '$':
                    if (i + 1 >= inner.Length || inner[i + 1] != '$')
                    {
                        return null;
                    }

                    value.Append('$');
                    i++;
                    break;
                case '\\':
                    if (i + 1 >= inner.Length)
                    {
                        return null;
                    }

                    var next = inner[++i];
                    switch (next)
                    {
                        case '\\':
                            value.Append('\\');
                            break;
                        case '"':
                            value.Append('"');
                            break;
                        case 'n':
                            value.Append('\n');
                            break;
                        case 'r':
                            value.Append('\r');
                            break;
                        case 't':
                            value.Append('\t');
                            break;
                        case '0':
                            if (!IsOctal(inner, i + 1))
                            {
                                return null;
                            }

                            value.Append((char)Convert.ToInt32(inner.Substring(i + 1, 3), 8));
                            i += 3;
                            break;
                        default:
                            return null;
                    }

                    break;
                default:
                    if (char.IsControl(c) && c != '\u0080')
                    {
                        return null;
                    }

                    value.Append(c);
                    break;
            }
        }

        return value.ToString();
    }
}
