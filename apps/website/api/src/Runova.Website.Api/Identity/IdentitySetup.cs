using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Runova.Website.Api.ApiClients;
using Runova.Website.Core.ApiClients;
using Runova.Website.Core.Identity;
using Runova.Website.Data;
using Runova.Website.Data.Identity;

namespace Runova.Website.Api.Identity;

/// <summary>The named authorization policies. The fallback policy covers everything else.</summary>
internal static class Policies
{
    public const string Staff = "Staff";
    public const string Admin = "Admin";

    /// <summary>Writing news: Editors, Admins, and API clients with the <c>news:write</c> scope.</summary>
    public const string NewsWrite = "NewsWrite";

    /// <summary>Writing posts and media: Editors, Admins, and API clients with the <c>posts:write</c> scope.</summary>
    public const string PostsWrite = "PostsWrite";
}

internal static class IdentitySetup
{
    public const string SessionCookie = "__Host-runova-session";
    public const string AntiforgeryCookie = "__Host-runova-antiforgery";
    public const string AntiforgeryHeader = "X-XSRF-TOKEN";

    /// <summary>
    /// Identity on <see cref="AppDbContext"/> with the contract's password, lockout and two-factor
    /// rules, the session cookie, antiforgery, and a fallback policy that denies anyone not signed in.
    /// An API client never passes it: a client reaches only the endpoints its scopes name.
    /// </summary>
    public static IServiceCollection AddWebsiteIdentity(this IServiceCollection services)
    {
        services.TryAddSingleton(TimeProvider.System);

        services.AddIdentity<AppUser, AppRole>(options =>
            {
                options.Password.RequiredLength = 12;
                options.Password.RequiredUniqueChars = 1;
                options.Password.RequireDigit = false;
                options.Password.RequireLowercase = false;
                options.Password.RequireUppercase = false;
                options.Password.RequireNonAlphanumeric = false;

                options.Lockout.MaxFailedAccessAttempts = 5;
                options.Lockout.DefaultLockoutTimeSpan = TimeSpan.FromMinutes(15);
                options.Lockout.AllowedForNewUsers = true;

                options.User.RequireUniqueEmail = true;
                options.Tokens.AuthenticatorTokenProvider = TokenOptions.DefaultAuthenticatorProvider;
            })
            .AddEntityFrameworkStores<AppDbContext>()
            .AddTokenProvider<OneTimeAuthenticatorTokenProvider>(TokenOptions.DefaultAuthenticatorProvider);

        services.ConfigureApplicationCookie(options =>
        {
            options.Cookie.Name = SessionCookie;
            options.Cookie.HttpOnly = true;
            options.Cookie.SecurePolicy = CookieSecurePolicy.Always;
            options.Cookie.SameSite = SameSiteMode.Strict;
            options.Cookie.Path = "/";
            options.ExpireTimeSpan = TimeSpan.FromHours(8);
            options.SlidingExpiration = true;

            // An API never redirects to a sign-in page; status code pages turn these into problem details.
            options.Events.OnRedirectToLogin = context => SetStatus(context.Response, StatusCodes.Status401Unauthorized);
            options.Events.OnRedirectToAccessDenied = context => SetStatus(context.Response, StatusCodes.Status403Forbidden);
        });

        // A disabled user, or one whose two-factor was reset, loses their session within 5 minutes.
        services.Configure<SecurityStampValidatorOptions>(options => options.ValidationInterval = TimeSpan.FromMinutes(5));

        services.AddAntiforgery(options =>
        {
            options.HeaderName = AntiforgeryHeader;
            options.Cookie.Name = AntiforgeryCookie;
            options.Cookie.HttpOnly = true;
            options.Cookie.SecurePolicy = CookieSecurePolicy.Always;
            options.Cookie.SameSite = SameSiteMode.Strict;
            options.Cookie.Path = "/";
        });

        var signedInUser = new AuthorizationPolicyBuilder()
            .RequireAuthenticatedUser()
            .RequireAssertion(context => !ApiClientPrincipal.IsApiClient(context.User))
            .Build();
        services.AddAuthorizationBuilder()
            .SetDefaultPolicy(signedInUser)
            .SetFallbackPolicy(signedInUser)
            .AddPolicy(Policies.Staff, policy => policy.RequireRole(Roles.Admin, Roles.Editor))
            .AddPolicy(Policies.Admin, policy => policy.RequireRole(Roles.Admin))
            .AddPolicy(Policies.NewsWrite, policy => policy.RequireAssertion(context => IsStaffOrHasScope(context.User, ApiScopes.NewsWrite)))
            .AddPolicy(Policies.PostsWrite, policy => policy.RequireAssertion(context => IsStaffOrHasScope(context.User, ApiScopes.PostsWrite)));
        services.AddSingleton<IAuthorizationMiddlewareResultHandler, RouteOnlyAuthorizationResultHandler>();

        return services;
    }

    /// <summary>
    /// Authentication, the 401 for a failed signature, the per-client rate limit, the antiforgery
    /// check (which needs the user), authorization, and then <c>Idempotency-Key</c>, which keeps
    /// answers only for a caller that was allowed in.
    /// </summary>
    public static WebApplication UseWebsiteIdentity(this WebApplication app)
    {
        app.UseAuthentication();
        app.UseSignatureRefusals();
        app.UseRateLimiter();
        app.UseWebsiteAntiforgery();
        app.UseAuthorization();
        app.UseIdempotencyKeys();
        return app;
    }

    private static bool IsStaffOrHasScope(ClaimsPrincipal user, string scope) =>
        user.IsInRole(Roles.Admin) || user.IsInRole(Roles.Editor) || ApiClientPrincipal.HasScope(user, scope);

    private static Task SetStatus(HttpResponse response, int status)
    {
        response.StatusCode = status;
        return Task.CompletedTask;
    }
}
