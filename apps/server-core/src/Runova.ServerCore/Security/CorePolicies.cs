using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.EntityFrameworkCore;
using Runova.ServerCore.Data;

namespace Runova.ServerCore.Security;

/// <summary>
/// Named policies. Every endpoint and hub method names one (or is explicitly anonymous), and
/// anything left unmarked falls back to requiring a signed-in caller.
/// </summary>
/// <remarks>
/// Roles nest: Owner includes Admin, Admin includes Operator, Operator includes Viewer. Account
/// self-service (signing out, stepping up, a user's own second factor, devices and sessions) is
/// open to every role; changing the server itself needs Operator or more.
/// </remarks>
internal static class CorePolicies
{
    public const string SignedIn = "signed-in";
    public const string Viewer = "viewer";
    public const string Operator = "operator";
    public const string Admin = "admin";
    public const string Owner = "owner";

    /// <summary>The password or a TOTP code was entered again within the last ten minutes.</summary>
    public const string StepUp = "step-up";

    public static readonly TimeSpan StepUpWindow = TimeSpan.FromMinutes(10);

    /// <summary>Policies a Viewer must never pass: they change the server or its users.</summary>
    public static readonly string[] AboveViewer = [Operator, Admin, Owner];

    public static AuthorizationPolicy RequireSignedIn { get; } =
        new AuthorizationPolicyBuilder(CoreAuthentication.Scheme).RequireAuthenticatedUser().Build();

    public static AuthorizationBuilder AddCorePolicies(this AuthorizationBuilder builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        return builder
            .SetDefaultPolicy(RequireSignedIn)
            .SetFallbackPolicy(RequireSignedIn)
            .AddPolicy(SignedIn, RequireSignedIn)
            .AddPolicy(Viewer, Roles(CoreRoles.Viewer, CoreRoles.Operator, CoreRoles.Admin, CoreRoles.Owner))
            .AddPolicy(Operator, Roles(CoreRoles.Operator, CoreRoles.Admin, CoreRoles.Owner))
            .AddPolicy(Admin, Roles(CoreRoles.Admin, CoreRoles.Owner))
            .AddPolicy(Owner, Roles(CoreRoles.Owner))
            .AddPolicy(
                StepUp,
                new AuthorizationPolicyBuilder(CoreAuthentication.Scheme)
                    .RequireAuthenticatedUser()
                    .AddRequirements(new StepUpRequirement())
                    .Build());
    }

    private static AuthorizationPolicy Roles(params string[] roles) =>
        new AuthorizationPolicyBuilder(CoreAuthentication.Scheme)
            .RequireAuthenticatedUser()
            .RequireRole(roles)
            .Build();
}

internal sealed class StepUpRequirement : IAuthorizationRequirement;

/// <summary>
/// Reads the session's step-up time from the database on every check, not from the token: a hub
/// connection authenticates once, and a step-up done after that has to count at once.
/// </summary>
internal sealed class StepUpHandler(CoreDbContext db, TimeProvider time) : AuthorizationHandler<StepUpRequirement>
{
    protected override async Task HandleRequirementAsync(AuthorizationHandlerContext context, StepUpRequirement requirement)
    {
        ArgumentNullException.ThrowIfNull(context);
        if (!Guid.TryParse(context.User.FindFirstValue(CoreAuthentication.SessionClaim), out var sessionId))
        {
            return;
        }

        var until = await db.DeviceSessions
            .Where(s => s.Id == sessionId)
            .Select(s => s.StepUpUntil)
            .FirstOrDefaultAsync();
        if (until is long deadline && deadline > time.GetUtcNow().ToUnixTimeMilliseconds())
        {
            context.Succeed(requirement);
        }
    }
}
