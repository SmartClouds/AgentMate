using System.Globalization;
using System.Security.Claims;
using Runova.Website.Core.ApiClients;
using Runova.Website.Core.Audit;

namespace Runova.Website.Api.ApiClients;

/// <summary>
/// The user a signed request runs as: the client's id and name, one <c>scope</c> claim per scope,
/// and an actor kind that tells it apart from a staff session.
/// </summary>
internal static class ApiClientPrincipal
{
    public const string ActorKindClaim = "runova:actor-kind";
    public const string ScopeClaim = "scope";

    public static ClaimsPrincipal Create(ApiClient client, string scheme)
    {
        List<Claim> claims =
        [
            new(ClaimTypes.NameIdentifier, client.Id.ToString(CultureInfo.InvariantCulture)),
            new(ClaimTypes.Name, client.Name),
            new(ActorKindClaim, AuditActorKinds.ApiClient),
            .. client.Scopes.Select(scope => new Claim(ScopeClaim, scope)),
        ];
        return new ClaimsPrincipal(new ClaimsIdentity(claims, scheme));
    }

    public static bool IsApiClient(ClaimsPrincipal? user) =>
        user?.Identity?.IsAuthenticated == true && user.HasClaim(ActorKindClaim, AuditActorKinds.ApiClient);

    /// <summary>The signed-in API client's id, or null for anyone else.</summary>
    public static long? ClientId(ClaimsPrincipal? user) =>
        IsApiClient(user) && long.TryParse(user!.FindFirstValue(ClaimTypes.NameIdentifier), CultureInfo.InvariantCulture, out var id)
            ? id
            : null;

    public static bool HasScope(ClaimsPrincipal user, string scope) => IsApiClient(user) && user.HasClaim(ScopeClaim, scope);
}
