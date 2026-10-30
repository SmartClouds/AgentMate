using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using Sentry.Extensibility;
using Sentry.Protocol.Envelopes;

namespace Runova.Website.IntegrationTests.Infrastructure;

/// <summary>
/// Stands in for Sentry's HTTP transport and keeps every envelope as the text that would have been
/// sent, so a test can look for anything that should not be there.
/// </summary>
internal sealed class FakeSentryTransport : ITransport
{
    /// <summary>A well-formed DSN that turns Sentry on. Nothing is sent to it.</summary>
    public const string Dsn = "https://public@sentry.invalid/1";

    private readonly ConcurrentQueue<string> _envelopes = new();

    public IReadOnlyList<string> Envelopes => [.. _envelopes];

    /// <summary>The payload of every event item in every envelope.</summary>
    public IReadOnlyList<JsonElement> Events => [.. Envelopes.SelectMany(EventsIn)];

    public async Task SendEnvelopeAsync(Envelope envelope, CancellationToken cancellationToken = default)
    {
        using var stream = new MemoryStream();
        await envelope.SerializeAsync(stream, null, cancellationToken);
        _envelopes.Enqueue(Encoding.UTF8.GetString(stream.ToArray()));
    }

    // An envelope is a header line, then for each item a header line and a payload line.
    private static IEnumerable<JsonElement> EventsIn(string envelope)
    {
        var lines = envelope.Split('\n', StringSplitOptions.RemoveEmptyEntries);
        for (var i = 1; i + 1 < lines.Length; i += 2)
        {
            using var header = JsonDocument.Parse(lines[i]);
            if (header.RootElement.GetProperty("type").GetString() == "event")
            {
                using var payload = JsonDocument.Parse(lines[i + 1]);
                yield return payload.RootElement.Clone();
            }
        }
    }
}
