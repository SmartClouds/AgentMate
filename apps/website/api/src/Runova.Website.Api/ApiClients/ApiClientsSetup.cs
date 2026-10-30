using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Identity;
using Runova.Website.Data;

namespace Runova.Website.Api.ApiClients;

internal static class ApiClientsSetup
{
    /// <summary>Picks the signature scheme for a signed request and the session cookie for any other.</summary>
    public const string Scheme = "RunovaSessionOrSignature";

    /// <summary>
    /// Signed requests beside the session cookie, the Data Protection key ring that seals the
    /// signing keys, and the per-client rate limit. Call it after <c>AddWebsiteIdentity</c>, so
    /// the defaults set here win over Identity's.
    /// </summary>
    public static IServiceCollection AddWebsiteApiClients(this IServiceCollection services)
    {
        services.AddDataProtection().PersistKeysToDbContext<AppDbContext>();
        services.AddSingleton<SigningKeys>();

        services.AddAuthentication(options =>
            {
                options.DefaultScheme = Scheme;
                options.DefaultAuthenticateScheme = Scheme;
                options.DefaultChallengeScheme = Scheme;
                options.DefaultForbidScheme = Scheme;
            })
            .AddPolicyScheme(Scheme, null, options => options.ForwardDefaultSelector = http =>
                SignatureAuthentication.IsSigned(http) ? SignatureAuthenticationHandler.SchemeName : IdentityConstants.ApplicationScheme)
            .AddScheme<AuthenticationSchemeOptions, SignatureAuthenticationHandler>(SignatureAuthenticationHandler.SchemeName, null);

        services.AddApiClientRateLimits();
        return services;
    }
}
