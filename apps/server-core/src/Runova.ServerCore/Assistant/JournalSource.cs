using System.Globalization;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.Channels;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Execution;

namespace Runova.ServerCore.Assistant;

/// <summary>A unit's journal, as checked by the hub: a unit name, how many lines, from when, and whether to follow.</summary>
internal sealed record JournalQuery(string Unit, int Lines, long? SinceUnixMs, bool Follow);

/// <summary>Where journal lines come from: journalctl on a server, a pretend journal in the DevHost.</summary>
internal interface IJournalSource
{
    IAsyncEnumerable<JournalLine> ReadAsync(JournalQuery query, CancellationToken cancellationToken);
}

internal static partial class JournalUnits
{
    public const int DefaultLines = 200;

    public const int MaxLines = 2_000;

    /// <summary>A systemd unit name: no option, path or glob can pass for one.</summary>
    public static bool IsUnit(string? unit) => unit is not null && UnitName().IsMatch(unit);

    [GeneratedRegex(@"^[A-Za-z0-9][A-Za-z0-9@_.:\\-]{0,127}$", RegexOptions.CultureInvariant)]
    private static partial Regex UnitName();
}

/// <summary>
/// journalctl's JSON output, a line at a time. It runs as the core does (no unit of its own: it
/// only reads), killed with its process group when the stream ends.
/// </summary>
internal sealed class JournalctlSource(IProcessRunner runner) : IJournalSource
{
    private const int MaxText = 8 * 1024;

    public async IAsyncEnumerable<JournalLine> ReadAsync(JournalQuery query, [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        List<string> arguments = ["--no-pager", "--output=json", $"--unit={query.Unit}", $"--lines={query.Lines.ToString(CultureInfo.InvariantCulture)}"];
        if (query.SinceUnixMs is long since)
        {
            arguments.Add($"--since=@{(since / 1000).ToString(CultureInfo.InvariantCulture)}");
        }

        if (query.Follow)
        {
            arguments.Add("--follow");
        }

        var lines = Channel.CreateBounded<JournalLine>(new BoundedChannelOptions(4_096) { FullMode = BoundedChannelFullMode.DropOldest });
        var running = Task.Run(
            async () =>
            {
                try
                {
                    await runner.RunAsync(
                        new ProcessSpec
                        {
                            Program = "journalctl",
                            Arguments = arguments,
                            Timeout = query.Follow ? ProcessRunner.MaxTimeout : TimeSpan.FromSeconds(30),
                            MaxOutputBytes = 0,
                        },
                        line =>
                        {
                            if (line.Stream == OutputStream.Out && Parse(line.Text) is { } parsed)
                            {
                                lines.Writer.TryWrite(parsed);
                            }
                        },
                        cancellationToken);
                    lines.Writer.TryComplete();
                }
                catch (Exception error)
                {
                    lines.Writer.TryComplete(error);
                }
            },
            CancellationToken.None);

        await foreach (var line in lines.Reader.ReadAllAsync(cancellationToken))
        {
            yield return line;
        }

        await running;
    }

    /// <summary>One entry of journalctl's JSON output, or null for anything else.</summary>
    public static JournalLine? Parse(string json)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return null;
            }

            var at = root.TryGetProperty("__REALTIME_TIMESTAMP", out var stamp)
                && long.TryParse(stamp.GetString(), NumberStyles.None, CultureInfo.InvariantCulture, out var micros)
                    ? micros / 1000
                    : 0;
            var priority = root.TryGetProperty("PRIORITY", out var level)
                && int.TryParse(level.GetString(), NumberStyles.None, CultureInfo.InvariantCulture, out var value)
                    ? Math.Clamp(value, 0, 7)
                    : 6;
            var text = root.TryGetProperty("MESSAGE", out var message) ? Text(message) : string.Empty;
            return new JournalLine(at, priority, text.Length > MaxText ? text[..MaxText] : text);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>journald stores a message that is not valid UTF-8 as an array of bytes.</summary>
    private static string Text(JsonElement message) => message.ValueKind switch
    {
        JsonValueKind.String => message.GetString() ?? string.Empty,
        JsonValueKind.Array => Encoding.UTF8.GetString([.. message.EnumerateArray().Where(b => b.ValueKind == JsonValueKind.Number).Select(b => (byte)Math.Clamp(b.GetInt32(), 0, 255))]),
        _ => string.Empty,
    };
}
