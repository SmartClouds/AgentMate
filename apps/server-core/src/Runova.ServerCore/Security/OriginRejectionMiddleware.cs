using Microsoft.Net.Http.Headers;

namespace Runova.ServerCore.Security;

/// <summary>
/// Browsers are never clients of the core, and every request a web page can make carries an
/// Origin header. Refusing those outright, before authentication, closes DNS rebinding and
/// cross-site WebSocket hijacking for good.
/// </summary>
internal sealed class OriginRejectionMiddleware(RequestDelegate next)
{
    public Task InvokeAsync(HttpContext context)
    {
        ArgumentNullException.ThrowIfNull(context);
        if (context.Request.Headers.ContainsKey(HeaderNames.Origin))
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            return Task.CompletedTask;
        }

        return next(context);
    }
}
