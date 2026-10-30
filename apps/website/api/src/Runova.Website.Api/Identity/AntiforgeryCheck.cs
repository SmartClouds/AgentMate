using Microsoft.AspNetCore.Antiforgery;
using Runova.Website.Core.Problems;

namespace Runova.Website.Api.Identity;

/// <summary>Marks an anonymous endpoint that still needs the antiforgery header, such as sign-in.</summary>
internal sealed class RequiresAntiforgery
{
    public static readonly RequiresAntiforgery Instance = new();

    private RequiresAntiforgery()
    {
    }
}

internal static class AntiforgeryCheck
{
    /// <summary>The readable cookie the admin app copies into the antiforgery header.</summary>
    public const string ReadableCookie = "XSRF-TOKEN";

    /// <summary>
    /// Checks the antiforgery header on every unsafe request that came with a session, and on the
    /// endpoints marked <see cref="RequiresAntiforgery"/>. The built-in middleware only looks at
    /// form posts, and this API takes JSON. A missing or wrong token answers 400
    /// <c>validation-failed</c> with <c>errors.antiforgery</c>.
    /// </summary>
    public static IApplicationBuilder UseWebsiteAntiforgery(this IApplicationBuilder app) => app.Use(async (http, next) =>
    {
        if (NeedsToken(http) && !await http.RequestServices.GetRequiredService<IAntiforgery>().IsRequestValidAsync(http))
        {
            http.Response.StatusCode = StatusCodes.Status400BadRequest;
            await http.RequestServices.GetRequiredService<IProblemDetailsService>().WriteAsync(new ProblemDetailsContext
            {
                HttpContext = http,
                ProblemDetails = new HttpValidationProblemDetails(new Dictionary<string, string[]>
                {
                    ["antiforgery"] = [$"Send the {IdentitySetup.AntiforgeryHeader} header with the value of the {ReadableCookie} cookie."],
                })
                {
                    Type = ProblemTypes.ValidationFailed.Uri,
                    Title = ProblemTypes.ValidationFailed.Title,
                    Status = StatusCodes.Status400BadRequest,
                    Detail = "The antiforgery token is missing or not valid.",
                },
            });
            return;
        }

        await next(http);
    });

    /// <summary>
    /// Issues a request token for whoever <see cref="HttpContext.User"/> is now, stores the
    /// antiforgery cookie, and sets the readable <c>XSRF-TOKEN</c> cookie to the token.
    /// </summary>
    public static string IssueToken(HttpContext http)
    {
        var token = http.RequestServices.GetRequiredService<IAntiforgery>().GetAndStoreTokens(http).RequestToken!;
        http.Response.Cookies.Append(ReadableCookie, token, new CookieOptions
        {
            HttpOnly = false,
            Secure = true,
            SameSite = SameSiteMode.Strict,
            Path = "/",
        });
        return token;
    }

    private static bool NeedsToken(HttpContext http)
    {
        var method = http.Request.Method;
        if (HttpMethods.IsGet(method) || HttpMethods.IsHead(method) || HttpMethods.IsOptions(method) || HttpMethods.IsTrace(method))
        {
            return false;
        }

        return http.User.Identity?.IsAuthenticated == true
            || http.GetEndpoint()?.Metadata.GetMetadata<RequiresAntiforgery>() is not null;
    }
}
