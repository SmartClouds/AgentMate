using System.Security.Claims;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.Options;
using Runova.ServerCore.Data;
using Runova.ServerCore.DirectTls;

namespace Runova.ServerCore.Security;

internal static class CoreAuthentication
{
    /// <summary>The scheme every protected endpoint and the hub challenge with.</summary>
    public const string Scheme = "RunovaDevice";

    public const string SessionClaim = "runova:sid";
    public const string DeviceClaim = "runova:did";
}

/// <summary>
/// Accepts `Authorization: Bearer &lt;access token&gt;` and nothing else: no cookies and no token in
/// the query string, since browsers are never clients. The session behind the token is checked on
/// every request and every hub connection, and the ticket expires with the token, so the hub
/// closes a connection whose token ran out (CloseOnAuthenticationExpiration).
/// </summary>
internal sealed class DeviceTokenHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> options,
    ILoggerFactory logger,
    UrlEncoder encoder,
    AccessTokens tokens,
    DeviceSessions sessions,
    UserManager<CoreUser> users)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    private const string BearerPrefix = "Bearer ";

    protected override async Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        var header = Request.Headers.Authorization.ToString();
        if (!header.StartsWith(BearerPrefix, StringComparison.Ordinal))
        {
            return AuthenticateResult.NoResult();
        }

        var payload = tokens.Read(header[BearerPrefix.Length..].Trim());
        if (payload is null)
        {
            return AuthenticateResult.Fail("The access token is not valid or has expired.");
        }

        var check = await sessions.CheckAsync(payload.SessionId, forRenewal: false, Context.RequestAborted);
        if (check.State != SessionState.Active
            || check.User is null
            || check.User.Id != payload.UserId
            || check.Session!.DeviceId != payload.DeviceId)
        {
            return AuthenticateResult.Fail("The session behind this token has ended.");
        }

        // Over direct TLS the token has to belong to the device whose key made the handshake, so a
        // token copied off one computer is useless on another computer's certificate.
        if (DirectTlsDevices.Mismatch(Context, payload.DeviceId))
        {
            return AuthenticateResult.Fail("This token belongs to another device than the client certificate.");
        }

        var claims = new List<Claim>
        {
            new(ClaimTypes.NameIdentifier, check.User.Id.ToString("D")),
            new(ClaimTypes.Name, check.User.UserName ?? string.Empty),
            new(CoreAuthentication.SessionClaim, payload.SessionId.ToString("D")),
            new(CoreAuthentication.DeviceClaim, payload.DeviceId.ToString("D")),
        };
        claims.AddRange((await users.GetRolesAsync(check.User)).Select(role => new Claim(ClaimTypes.Role, role)));

        var principal = new ClaimsPrincipal(new ClaimsIdentity(claims, Scheme.Name));
        var properties = new AuthenticationProperties
        {
            ExpiresUtc = DateTimeOffset.FromUnixTimeMilliseconds(payload.ExpiresAt),
        };
        return AuthenticateResult.Success(new AuthenticationTicket(principal, properties, Scheme.Name));
    }
}
