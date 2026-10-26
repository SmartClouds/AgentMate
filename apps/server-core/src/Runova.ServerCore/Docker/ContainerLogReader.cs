using System.Text;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Docker;

/// <summary>
/// Turns a container's raw log output into lines: stdout and stderr each split on their own
/// (a chunk can end in the middle of a line or of a character), Docker's timestamp taken off the
/// front, a TTY's carriage returns dropped, and every line redacted with the container's own
/// environment values before it leaves the core. Lines at or before <c>afterTimestamp</c> are
/// skipped, which is how a stream resumes after a reconnect without repeating itself.
/// </summary>
internal sealed class ContainerLogReader
{
    /// <summary>Longer lines are cut, so one runaway line cannot hold the stream's memory.</summary>
    public const int MaxLineChars = 16 * 1024;

    private readonly long? _after;
    private readonly Dictionary<ContainerLogSource, LineState> _streams;

    public ContainerLogReader(Redactor redactor, string? afterTimestamp)
    {
        ArgumentNullException.ThrowIfNull(redactor);
        _after = DockerTime.TryParseNanoseconds(afterTimestamp, out var after) ? after : null;
        _streams = new()
        {
            [ContainerLogSource.Stdout] = new LineState(new LineRedactor(redactor)),
            [ContainerLogSource.Stderr] = new LineState(new LineRedactor(redactor)),
        };
    }

    public IReadOnlyList<ContainerLogLine> Add(LogChunk chunk)
    {
        ArgumentNullException.ThrowIfNull(chunk);
        var state = _streams[chunk.Stream];
        var characters = new char[state.Decoder.GetCharCount(chunk.Data.Span, flush: false)];
        state.Decoder.GetChars(chunk.Data.Span, characters, flush: false);
        var lines = new List<ContainerLogLine>();
        foreach (var character in characters)
        {
            if (character == '\n')
            {
                Emit(chunk.Stream, state, lines);
                continue;
            }

            state.Line.Append(character);
            if (state.Line.Length >= MaxLineChars + 40)
            {
                Emit(chunk.Stream, state, lines);
            }
        }

        return lines;
    }

    /// <summary>The last line of each stream when the output ended without a newline.</summary>
    public IReadOnlyList<ContainerLogLine> Flush()
    {
        var lines = new List<ContainerLogLine>();
        foreach (var (stream, state) in _streams)
        {
            if (state.Line.Length > 0)
            {
                Emit(stream, state, lines);
            }
        }

        return lines;
    }

    private void Emit(ContainerLogSource stream, LineState state, List<ContainerLogLine> lines)
    {
        var raw = state.Line.ToString().TrimEnd('\r');
        state.Line.Clear();
        var space = raw.IndexOf(' ', StringComparison.Ordinal);
        string text;
        if (space > 0 && DockerTime.TryParseNanoseconds(raw[..space], out var nanoseconds))
        {
            state.Timestamp = raw[..space];
            state.Nanoseconds = nanoseconds;
            text = raw[(space + 1)..];
        }
        else
        {
            // The rest of a line that was cut: it carries the time of its start.
            text = raw;
        }

        if (_after is long after && state.Nanoseconds <= after)
        {
            return;
        }

        if (text.Length > MaxLineChars)
        {
            text = text[..MaxLineChars];
        }

        lines.Add(new ContainerLogLine(stream, state.Timestamp, state.Nanoseconds / 1_000_000, state.Redactor.Redact(text)));
    }

    private sealed class LineState(LineRedactor redactor)
    {
        public Decoder Decoder { get; } = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false).GetDecoder();

        public StringBuilder Line { get; } = new();

        public LineRedactor Redactor { get; } = redactor;

        public string Timestamp { get; set; } = string.Empty;

        public long Nanoseconds { get; set; }
    }
}
