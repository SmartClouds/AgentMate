using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Authorization.Policy;

namespace Runova.Website.Api.Identity;

/// <summary>
/// Keeps the fallback policy to real endpoints. Without a route there is nothing to protect, so an
/// unknown path still answers 404 and a wrong method 405 instead of 401.
/// </summary>
internal sealed class RouteOnlyAuthorizationResultHandler : IAuthorizationMiddlewareResultHandler
{
    private readonly AuthorizationMiddlewareResultHandler _default = new();

    public Task HandleAsync(
        RequestDelegate next,
        HttpContext context,
        AuthorizationPolicy policy,
        PolicyAuthorizationResult authorizeResult)
    {
        if ((authorizeResult.Challenged || authorizeResult.Forbidden) && context.GetEndpoint() is not RouteEndpoint)
        {
            return next(context);
        }

        return _default.HandleAsync(next, context, policy, authorizeResult);
    }
}
