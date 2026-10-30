namespace Runova.Website.Api.Telemetry;

/// <summary>
/// Takes cookies and <see cref="SecretHeaders"/> out of everything sent to Sentry. Sentry already
/// leaves out most personal data while <c>SendDefaultPii</c> is off; this covers what it keeps.
/// </summary>
internal static class SentryScrubbing
{
    public static SentryEvent Scrub(SentryEvent sentryEvent, SentryHint hint)
    {
        sentryEvent.Request.Cookies = null;
        RemoveSecrets(sentryEvent.Request.Headers);
        sentryEvent.Contexts.Response.Cookies = null;
        RemoveSecrets(sentryEvent.Contexts.Response.Headers);
        return sentryEvent;
    }

    public static Breadcrumb? Scrub(Breadcrumb breadcrumb, SentryHint hint)
    {
        if (breadcrumb.Data is not { } data || !data.Keys.Any(SecretHeaders.IsSecret))
        {
            return breadcrumb;
        }

        // The public constructor stamps the time anew; this runs as the breadcrumb is added, so
        // the stamps differ by nothing that matters.
        return new Breadcrumb(
            breadcrumb.Message ?? "",
            breadcrumb.Type ?? "",
            data.Where(entry => !SecretHeaders.IsSecret(entry.Key)).ToDictionary(),
            breadcrumb.Category,
            breadcrumb.Level);
    }

    private static void RemoveSecrets(IDictionary<string, string> headers)
    {
        foreach (var name in headers.Keys.Where(SecretHeaders.IsSecret).ToList())
        {
            headers.Remove(name);
        }
    }
}
