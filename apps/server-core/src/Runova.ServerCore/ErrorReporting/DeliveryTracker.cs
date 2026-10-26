using System.Globalization;
using System.Net;

namespace Runova.ServerCore.ErrorReporting;

/// <summary>
/// How sending to Sentry is going: records delivered, when the last delivery and the last failure
/// were, and what went wrong in words for a person. Times are Unix milliseconds.
/// </summary>
internal sealed record ErrorDelivery(long SentCount, long? LastSentAt, long? LastFailedAt, string? LastError, int? LastStatus)
{
    public static ErrorDelivery None { get; } = new(0, null, null, null, null);
}

/// <summary>Collects the outcome of each request to Sentry; read from the hub while the exporter writes.</summary>
internal sealed class DeliveryTracker(TimeProvider time, string authority)
{
    private readonly Lock _gate = new();

    private ErrorDelivery _state = ErrorDelivery.None;

    public ErrorDelivery Snapshot()
    {
        lock (_gate)
        {
            return _state;
        }
    }

    public void Delivered(int status, int records)
    {
        lock (_gate)
        {
            _state = _state with
            {
                SentCount = _state.SentCount + records,
                LastSentAt = Now,
                LastError = null,
                LastStatus = status,
            };
        }
    }

    public void Refused(HttpStatusCode status)
    {
        lock (_gate)
        {
            _state = _state with { LastFailedAt = Now, LastError = Explain(status), LastStatus = (int)status };
        }
    }

    public void Unreachable(string reason)
    {
        lock (_gate)
        {
            _state = _state with
            {
                LastFailedAt = Now,
                LastError = $"Could not reach {authority}: {reason}",
                LastStatus = null,
            };
        }
    }

    private long Now => time.GetUtcNow().ToUnixTimeMilliseconds();

    private static string Explain(HttpStatusCode status)
    {
        var code = ((int)status).ToString(CultureInfo.InvariantCulture);
        return status switch
        {
            HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden =>
                $"Sentry rejected the key in this DSN (HTTP {code}). Check that it is the key of the project you meant.",
            HttpStatusCode.NotFound =>
                $"Sentry has no project with this id, or no OpenTelemetry logs address (HTTP {code}). A self-hosted Sentry needs a recent version.",
            HttpStatusCode.TooManyRequests =>
                $"Sentry says this project is getting too many events right now (HTTP {code}).",
            _ when (int)status is >= 300 and < 400 =>
                $"Sentry answered with a redirect (HTTP {code}). The core does not follow redirects, so check the host in the DSN.",
            _ => $"Sentry answered HTTP {code}.",
        };
    }
}
