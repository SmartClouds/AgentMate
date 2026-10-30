using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Runova.Website.Core.Identity;
using Runova.Website.Data;
using Runova.Website.Data.Identity;

namespace Runova.Website.Api.Identity;

/// <summary>The named authorization policies. The fallback policy covers everything else.</summary>
internal static class Policies
{
    public const string Staff = "Staff";
    public const string Admin = "Admin";
}

internal static class IdentitySetup
{
    public const string SessionCookie = "__Host-runova-session";
    public const string AntiforgeryCookie = "__Host-runova-antiforgery";
    public const string AntiforgeryHeader = "X-XSRF-TOKEN";

    /// <summary>
    /// Identity on <see cref="AppDbContext"/> with the contract's password, lockout and two-factor
    /// rules, the session cookie, antiforgery, and a fallback policy that denies anyone not signed in.
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

        services.AddAuthorizationBuilder()
            .SetFallbackPolicy(new AuthorizationPolicyBuilder().RequireAuthenticatedUser().Build())
            .AddPolicy(Policies.Staff, policy => policy.RequireRole(Roles.Admin, Roles.Editor))
            .AddPolicy(Policies.Admin, policy => policy.RequireRole(Roles.Admin));
        services.AddSingleton<IAuthorizationMiddlewareResultHandler, RouteOnlyAuthorizationResultHandler>();

        return services;
    }

    /// <summary>Authentication, then the antiforgery check (which needs the user), then authorization.</summary>
    public static WebApplication UseWebsiteIdentity(this WebApplication app)
    {
        app.UseAuthentication();
        app.UseWebsiteAntiforgery();
        app.UseAuthorization();
        return app;
    }

    private static Task SetStatus(HttpResponse response, int status)
    {
        response.StatusCode = status;
        return Task.CompletedTask;
    }
}
