namespace AgentMate.ServerCore.ErrorReporting;

/// <summary>
/// Sits in front of the network for the OTLP exporter: signs each request with the DSN's public key,
/// and writes down how Sentry answered (or that it could not be reached) for the status screen. The
/// exporter itself reports nothing a person could read.
/// </summary>
internal sealed class SentryDeliveryHandler(SentryDsn dsn, DeliveryTracker tracker, HttpMessageHandler inner) : DelegatingHandler(inner)
{
    private const string AuthHeaderName = "x-sentry-auth";

    protected override HttpResponseMessage Send(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var records = Prepare(request);
        try
        {
            return Record(base.Send(request, cancellationToken), records);
        }
        catch (Exception problem) when (problem is HttpRequestException or TaskCanceledException or OperationCanceledException)
        {
            tracker.Unreachable(Reason(problem));
            throw;
        }
    }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var records = Prepare(request);
        try
        {
            return Record(await base.SendAsync(request, cancellationToken), records);
        }
        catch (Exception problem) when (problem is HttpRequestException or TaskCanceledException or OperationCanceledException)
        {
            tracker.Unreachable(Reason(problem));
            throw;
        }
    }

    /// <summary>Signs the request and counts its records; the body is kept as bytes so reading it costs nothing.</summary>
    private int Prepare(HttpRequestMessage request)
    {
        request.Headers.Remove(AuthHeaderName);
        request.Headers.TryAddWithoutValidation(AuthHeaderName, dsn.AuthHeader);
        if (request.Content is null)
        {
            return 0;
        }

        byte[] body;
        using (var stream = new MemoryStream())
        {
            request.Content.ReadAsStream().CopyTo(stream);
            body = stream.ToArray();
        }

        var copy = new ByteArrayContent(body);
        foreach (var header in request.Content.Headers)
        {
            copy.Headers.TryAddWithoutValidation(header.Key, header.Value);
        }

        request.Content = copy;
        return OtlpRecordCounter.Count(body);
    }

    private HttpResponseMessage Record(HttpResponseMessage response, int records)
    {
        if (response.IsSuccessStatusCode)
        {
            tracker.Delivered((int)response.StatusCode, records);
        }
        else
        {
            tracker.Refused(response.StatusCode);
        }

        return response;
    }

    private static string Reason(Exception problem) =>
        problem is TaskCanceledException or OperationCanceledException ? "it did not answer in time." : problem.Message;
}
