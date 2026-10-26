using System.Net;
using System.Text;
using Runova.ServerCore.ErrorReporting;

namespace Runova.ServerCore.Tests.ErrorReporting;

/// <summary>One request the fake Sentry received. The body is Latin-1 text, so every byte survives and plain text can be searched for.</summary>
public sealed record CapturedRequest(HttpMethod Method, Uri Uri, Dictionary<string, string> Headers, string? ContentType, string Body)
{
    public string? Header(string name) => Headers.TryGetValue(name, out var value) ? value : null;
}

/// <summary>Stands in for Sentry: remembers every request and answers as the test says.</summary>
public sealed class FakeIngest : HttpMessageHandler
{
    private readonly Lock _gate = new();

    private readonly List<CapturedRequest> _requests = [];

    public Func<HttpRequestMessage, HttpResponseMessage> Respond { get; set; } = _ => new HttpResponseMessage(HttpStatusCode.OK);

    public IReadOnlyList<CapturedRequest> Requests
    {
        get
        {
            lock (_gate)
            {
                return [.. _requests];
            }
        }
    }

    /// <summary>Everything the fake received, as one string to search.</summary>
    public string AllBodies => string.Concat(Requests.Select(request => request.Body));

    protected override HttpResponseMessage Send(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        Capture(request);
        return Respond(request);
    }

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        Capture(request);
        return Task.FromResult(Respond(request));
    }

    private void Capture(HttpRequestMessage request)
    {
        using var stream = new MemoryStream();
        request.Content?.ReadAsStream().CopyTo(stream);
        var headers = request.Headers.ToDictionary(h => h.Key.ToLowerInvariant(), h => string.Join(", ", h.Value));
        var captured = new CapturedRequest(
            request.Method,
            request.RequestUri!,
            headers,
            request.Content?.Headers.ContentType?.MediaType,
            Encoding.Latin1.GetString(stream.ToArray()));
        lock (_gate)
        {
            _requests.Add(captured);
        }
    }
}

/// <summary>Hands the exporter the fake Sentry, so no test ever leaves the machine.</summary>
internal sealed class FakeIngestTransport(FakeIngest ingest) : IErrorReportingTransport
{
    public HttpMessageHandler CreateHandler() => ingest;
}
