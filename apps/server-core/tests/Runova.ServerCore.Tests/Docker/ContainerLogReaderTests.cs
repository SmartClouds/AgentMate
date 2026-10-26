using System.Text;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Docker;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Tests.Docker;

/// <summary>
/// Raw log output to lines: split per stream across chunk boundaries (UTF-8 included), Docker's
/// timestamp taken off the front, redacted with the container's own values, and resumable.
/// </summary>
public sealed class ContainerLogReaderTests
{
    private const string Secret = "s3cret-db-pass-981";

    private static LogChunk Out(string text) => new(ContainerLogSource.Stdout, Encoding.UTF8.GetBytes(text));

    private static LogChunk Err(string text) => new(ContainerLogSource.Stderr, Encoding.UTF8.GetBytes(text));

    [Fact]
    public void Lines_split_across_chunks_keep_their_stream_and_docker_timestamp()
    {
        var reader = new ContainerLogReader(new Redactor(), afterTimestamp: null);

        var first = reader.Add(Out("2026-10-01T12:00:05.492832345Z GET /orders/18 200\n2026-10-01T12:00:06.0Z GET /ord"));
        var second = reader.Add(Err("2026-10-01T12:00:06.100000001Z warn: slow\n"));
        var third = reader.Add(Out("ers/19 200\n"));

        var lines = first.Concat(second).Concat(third).ToList();
        Assert.Equal(
            [
                (ContainerLogSource.Stdout, "2026-10-01T12:00:05.492832345Z", "GET /orders/18 200"),
                (ContainerLogSource.Stderr, "2026-10-01T12:00:06.100000001Z", "warn: slow"),
                (ContainerLogSource.Stdout, "2026-10-01T12:00:06.0Z", "GET /orders/19 200"),
            ],
            lines.Select(line => (line.Stream, line.Timestamp, line.Text)));
        Assert.Equal(DateTimeOffset.Parse("2026-10-01T12:00:05.492Z", System.Globalization.CultureInfo.InvariantCulture).ToUnixTimeMilliseconds(), lines[0].AtUnixMs);
    }

    [Fact]
    public void A_character_split_between_chunks_survives_and_tty_carriage_returns_go()
    {
        var bytes = Encoding.UTF8.GetBytes("2026-10-01T12:00:06.673264641Z café processed\r\n");
        var split = Array.IndexOf(bytes, (byte)0xC3) + 1;
        var reader = new ContainerLogReader(new Redactor(), afterTimestamp: null);

        var lines = reader.Add(new LogChunk(ContainerLogSource.Stdout, bytes.AsMemory(0, split)))
            .Concat(reader.Add(new LogChunk(ContainerLogSource.Stdout, bytes.AsMemory(split))))
            .ToList();

        Assert.Equal("café processed", Assert.Single(lines).Text);
    }

    [Fact]
    public void Seeded_values_and_secret_shapes_are_masked()
    {
        var reader = new ContainerLogReader(new Redactor().With([Secret]), afterTimestamp: null);

        var lines = reader.Add(Err($"2026-10-01T12:00:06.1Z connecting with {Secret} and ghp_abcdefghijklmnopqrstuvwxyz0123456789\n"));

        var text = Assert.Single(lines).Text;
        Assert.DoesNotContain(Secret, text, StringComparison.Ordinal);
        Assert.DoesNotContain("ghp_", text, StringComparison.Ordinal);
        Assert.Contains(Redactor.Mask, text, StringComparison.Ordinal);
    }

    [Fact]
    public void After_a_timestamp_only_later_lines_come_through()
    {
        var reader = new ContainerLogReader(new Redactor(), afterTimestamp: "2026-10-01T12:00:06.000000002Z");

        var lines = reader.Add(Out(
            "2026-10-01T12:00:06.000000001Z old\n2026-10-01T12:00:06.000000002Z seen\n2026-10-01T12:00:06.000000003Z new\n2026-10-01T12:00:07Z newer\n"));

        Assert.Equal(["new", "newer"], lines.Select(line => line.Text));
    }

    [Fact]
    public void A_runaway_line_is_cut_and_a_last_line_without_newline_comes_out_at_the_end()
    {
        var reader = new ContainerLogReader(new Redactor(), afterTimestamp: null);

        var lines = reader.Add(Out("2026-10-01T12:00:06Z " + new string('x', ContainerLogReader.MaxLineChars * 2)))
            .Concat(reader.Add(Out("\n2026-10-01T12:00:07Z tail without newline")))
            .Concat(reader.Flush())
            .ToList();

        Assert.All(lines, line => Assert.True(line.Text.Length <= ContainerLogReader.MaxLineChars));
        Assert.Equal("tail without newline", lines[^1].Text);
        Assert.All(lines[..^1], line => Assert.Equal("2026-10-01T12:00:06Z", line.Timestamp));
    }
}
