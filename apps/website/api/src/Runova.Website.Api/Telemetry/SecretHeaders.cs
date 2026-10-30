namespace Runova.Website.Api.Telemetry;

/// <summary>
/// Request and response headers whose values never leave the API: cookies, credentials, the
/// antiforgery token and every <c>X-Runova-*</c> signing header.
/// </summary>
internal static class SecretHeaders
{
    private static readonly HashSet<string> _names = new(StringComparer.OrdinalIgnoreCase)
    {
        "Cookie",
        "Set-Cookie",
        "Authorization",
        "Proxy-Authorization",
        "X-XSRF-TOKEN",
    };

    public static bool IsSecret(string name) =>
        _names.Contains(name) || name.StartsWith("X-Runova-", StringComparison.OrdinalIgnoreCase);
}
