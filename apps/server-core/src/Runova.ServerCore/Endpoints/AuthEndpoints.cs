using System.Buffers.Text;
using System.Text;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Runova.ServerCore.Audit;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.DirectTls;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Endpoints;

/// <summary>
/// Per-user limits on sign-in attempts, on top of Identity's lockout and the global limit on the
/// auth routes: ten tries a minute per user name.
/// </summary>
internal sealed class AuthThrottle : IDisposable
{
    public const string Policy = "auth";

    private readonly PartitionedRateLimiter<string> _perUser = PartitionedRateLimiter.Create<string, string>(key =>
        RateLimitPartition.GetSlidingWindowLimiter(key, _ => new SlidingWindowRateLimiterOptions
        {
            PermitLimit = 10,
            Window = TimeSpan.FromMinutes(1),
            SegmentsPerWindow = 6,
            QueueLimit = 0,
        }));

    public bool TryAcquire(string userName)
    {
        using var lease = _perUser.AttemptAcquire(userName.ToUpperInvariant());
        return lease.IsAcquired;
    }

    public void Dispose() => _perUser.Dispose();
}

/// <summary>
/// Challenge, login and renewal. The only anonymous routes besides health: they run before there
/// is a token. The order of checks is fixed so that nothing can be probed on its own: the
/// challenge is spent first, then the signature, then the password (counting failures), then the
/// second factor (counting failures too).
/// </summary>
internal static class AuthEndpoints
{
    public const string Prefix = "/api/v1/auth";

    private const int MaxPasswordLength = 1024;

    private const string NotThisCertificate = "This device is not the one the client certificate belongs to.";

    public static IEndpointRouteBuilder MapAuthEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var auth = endpoints.MapGroup(Prefix).AllowAnonymous().RequireRateLimiting(AuthThrottle.Policy);
        auth.MapPost("/challenge", ChallengeAsync);
        auth.MapPost("/login", LoginAsync);
        auth.MapPost("/renew", RenewAsync);
        auth.MapPost("/enroll", EnrollAsync);
        return endpoints;
    }

    private static JsonHttpResult<AuthError> Refuse(
        AuthErrorCode code,
        string message,
        int status = StatusCodes.Status401Unauthorized,
        long? lockedOutUntil = null) =>
        TypedResults.Json(new AuthError(code, message, lockedOutUntil), CoreJson.Options, statusCode: status);

    private static async Task<Results<Ok<ChallengeResponse>, JsonHttpResult<AuthError>>> ChallengeAsync(
        ChallengeRequest request,
        HttpContext http,
        CoreDbContext db,
        AuthChallenges challenges,
        CancellationToken cancellationToken)
    {
        if (DirectTlsDevices.Mismatch(http, request.DeviceId))
        {
            return Refuse(AuthErrorCode.InvalidCredentials, NotThisCertificate, StatusCodes.Status403Forbidden);
        }

        var device = await db.Devices.AsNoTracking().FirstOrDefaultAsync(d => d.Id == request.DeviceId, cancellationToken);
        if (device is null)
        {
            return Refuse(AuthErrorCode.DeviceUnknown, "This core does not know this device. Enroll it first.");
        }

        if (device.RevokedAt is not null)
        {
            return Refuse(AuthErrorCode.DeviceRevoked, "This device was revoked. Enroll it again to sign in.");
        }

        if (request.Purpose == AuthPurpose.Renew && request.SessionId is null)
        {
            return Refuse(AuthErrorCode.ChallengeInvalid, "A renewal challenge names its session.", StatusCodes.Status400BadRequest);
        }

        var issued = challenges.Issue(
            device.Id,
            request.Purpose,
            request.Purpose == AuthPurpose.Renew ? request.SessionId : null);
        if (issued is null)
        {
            return Refuse(AuthErrorCode.RateLimited, "Too many sign-ins at once. Try again shortly.", StatusCodes.Status429TooManyRequests);
        }

        return TypedResults.Ok(new ChallengeResponse(issued.Id, issued.Nonce, issued.ExpiresAt));
    }

    private static async Task<Results<Ok<SignedInResponse>, JsonHttpResult<AuthError>>> LoginAsync(
        LoginRequest request,
        HttpContext http,
        CoreDbContext db,
        UserManager<CoreUser> users,
        AuthChallenges challenges,
        DeviceSessions sessions,
        AccessTokens tokens,
        AuthThrottle throttle,
        AuditLog audit,
        CancellationToken cancellationToken)
    {
        if (DirectTlsDevices.Mismatch(http, request.DeviceId))
        {
            return Refuse(AuthErrorCode.InvalidCredentials, NotThisCertificate, StatusCodes.Status403Forbidden);
        }

        var peer = PeerCredentials.UidOf(http);
        async Task<JsonHttpResult<AuthError>> Fail(AuthErrorCode code, string message, Guid? userId = null, long? lockedOutUntil = null)
        {
            await audit.AppendAsync(
                new AuditEntry(
                    "auth.login",
                    AuditResult.Failed,
                    userId,
                    request.DeviceId,
                    peer,
                    request.UserName,
                    new Dictionary<string, string?> { ["reason"] = code.ToString() }),
                cancellationToken);
            return Refuse(code, message, lockedOutUntil: lockedOutUntil);
        }

        // Spent first: a replay fails even when everything else would have been right.
        var challenge = challenges.Take(request.ChallengeId, AuthPurpose.Login, sessionId: null);
        if (challenge is null || challenge.DeviceId != request.DeviceId)
        {
            return await Fail(AuthErrorCode.ChallengeInvalid, "The challenge is used, expired or not for this. Ask for a new one.");
        }

        if (!throttle.TryAcquire(request.UserName ?? string.Empty))
        {
            return Refuse(AuthErrorCode.RateLimited, "Too many sign-in attempts. Wait a minute.", StatusCodes.Status429TooManyRequests);
        }

        var device = await db.Devices.FirstOrDefaultAsync(d => d.Id == request.DeviceId, cancellationToken);
        if (device is null)
        {
            return await Fail(AuthErrorCode.DeviceUnknown, "This core does not know this device. Enroll it first.");
        }

        if (device.RevokedAt is not null)
        {
            return await Fail(AuthErrorCode.DeviceRevoked, "This device was revoked. Enroll it again to sign in.", device.UserId);
        }

        var signed = Signature(request.Signature);
        var user = await users.FindByNameAsync(request.UserName ?? string.Empty);
        if (signed is null
            || !AuthMessage.Verify(device.PublicKey, signed, AuthPurpose.Login, challenge.Id, challenge.Nonce, device.Id, sessionId: null)
            || user is null
            || user.Id != device.UserId
            || string.IsNullOrEmpty(request.Password)
            || request.Password.Length > MaxPasswordLength)
        {
            return await Fail(AuthErrorCode.InvalidCredentials, "The user name, password or device key is wrong.", user?.Id);
        }

        if (await users.IsLockedOutAsync(user))
        {
            return await LockedOutAsync(user);
        }

        if (!await users.CheckPasswordAsync(user, request.Password))
        {
            await users.AccessFailedAsync(user);
            return await users.IsLockedOutAsync(user)
                ? await LockedOutAsync(user)
                : await Fail(AuthErrorCode.InvalidCredentials, "The user name, password or device key is wrong.", user.Id);
        }

        if (await users.GetTwoFactorEnabledAsync(user))
        {
            if (string.IsNullOrWhiteSpace(request.TotpCode) && string.IsNullOrWhiteSpace(request.RecoveryCode))
            {
                return Refuse(AuthErrorCode.TotpRequired, "Enter the code from your authenticator app.");
            }

            var secondFactor = !string.IsNullOrWhiteSpace(request.TotpCode)
                ? await users.VerifyTwoFactorTokenAsync(
                    user,
                    TokenOptions.DefaultAuthenticatorProvider,
                    request.TotpCode.Replace(" ", string.Empty, StringComparison.Ordinal))
                : (await users.RedeemTwoFactorRecoveryCodeAsync(user, request.RecoveryCode!.Trim())).Succeeded;
            if (!secondFactor)
            {
                await users.AccessFailedAsync(user);
                return await users.IsLockedOutAsync(user)
                    ? await LockedOutAsync(user)
                    : await Fail(AuthErrorCode.TotpInvalid, "That code is not right, or it was used already. Codes change every 30 seconds.", user.Id);
            }
        }

        await users.ResetAccessFailedCountAsync(user);
        var session = await sessions.StartAsync(user, device, cancellationToken);
        await audit.AppendAsync(
            new AuditEntry("auth.login", AuditResult.Success, user.Id, device.Id, peer, user.UserName),
            cancellationToken);
        return TypedResults.Ok(await SignedInAsync(users, tokens, user, device, session.Id));

        async Task<JsonHttpResult<AuthError>> LockedOutAsync(CoreUser lockedUser)
        {
            if (CoreIdentity.IsDisabled(lockedUser))
            {
                return await Fail(AuthErrorCode.LockedOut, CoreIdentity.DisabledMessage, lockedUser.Id);
            }

            var until = (await users.GetLockoutEndDateAsync(lockedUser))?.ToUnixTimeMilliseconds();
            return await Fail(
                AuthErrorCode.LockedOut,
                "Too many wrong attempts. This account is locked for 15 minutes.",
                lockedUser.Id,
                until);
        }
    }

    private static async Task<Results<Ok<SignedInResponse>, JsonHttpResult<AuthError>>> RenewAsync(
        RenewRequest request,
        HttpContext http,
        UserManager<CoreUser> users,
        AuthChallenges challenges,
        DeviceSessions sessions,
        AccessTokens tokens,
        AuditLog audit,
        CancellationToken cancellationToken)
    {
        var challenge = challenges.Take(request.ChallengeId, AuthPurpose.Renew, request.SessionId);
        if (challenge is null)
        {
            return Refuse(AuthErrorCode.ChallengeInvalid, "The challenge is used, expired or not for this. Ask for a new one.");
        }

        var check = await sessions.CheckAsync(request.SessionId, forRenewal: true, cancellationToken);
        switch (check.State)
        {
            case SessionState.DeviceRevoked:
                return Refuse(AuthErrorCode.DeviceRevoked, "This device was revoked. Enroll it again to sign in.");
            case SessionState.Revoked:
                return Refuse(AuthErrorCode.SessionRevoked, "This session was ended. Sign in again.");
            case SessionState.Expired:
                return Refuse(AuthErrorCode.SessionExpired, "This session has expired. Sign in again.");
        }

        var device = check.Device!;
        if (DirectTlsDevices.Mismatch(http, device.Id))
        {
            return Refuse(AuthErrorCode.InvalidCredentials, NotThisCertificate, StatusCodes.Status403Forbidden);
        }

        if (device.Id != challenge.DeviceId)
        {
            return Refuse(AuthErrorCode.InvalidCredentials, "This challenge was issued to another device.");
        }

        var signed = Signature(request.Signature);
        if (signed is null || !AuthMessage.Verify(device.PublicKey, signed, AuthPurpose.Renew, challenge.Id, challenge.Nonce, device.Id, request.SessionId))
        {
            await audit.AppendAsync(
                new AuditEntry("auth.renew", AuditResult.Failed, check.User!.Id, device.Id, PeerCredentials.UidOf(http)),
                cancellationToken);
            return Refuse(AuthErrorCode.InvalidCredentials, "The device key is wrong.");
        }

        await sessions.RenewedAsync(check.Session!, device, cancellationToken);
        return TypedResults.Ok(await SignedInAsync(users, tokens, check.User!, device, check.Session!.Id));
    }

    /// <summary>
    /// Redeems an Owner's enrollment code for a new device. The code is checked before the
    /// password, so passwords cannot be tried without one, and a mistyped password leaves the code
    /// usable (its lifetime and the account lockout still bound the attempts).
    /// </summary>
    private static async Task<Results<Ok<EnrollResponse>, JsonHttpResult<AuthError>>> EnrollAsync(
        EnrollRequest request,
        HttpContext http,
        CoreDbContext db,
        UserManager<CoreUser> users,
        EnrollmentCodes codes,
        AuthThrottle throttle,
        AuditLog audit,
        TimeProvider time,
        CancellationToken cancellationToken)
    {
        // A caller over direct TLS is an enrolled device already; a new one enrolls through SSH.
        if (DirectTlsDevices.IsDirect(http))
        {
            return Refuse(AuthErrorCode.InvalidCredentials, "Enroll a new device over SSH, not over direct TLS.", StatusCodes.Status403Forbidden);
        }

        var peer = PeerCredentials.UidOf(http);
        if (!throttle.TryAcquire(request.UserName ?? string.Empty))
        {
            return Refuse(AuthErrorCode.RateLimited, "Too many attempts. Wait a minute.", StatusCodes.Status429TooManyRequests);
        }

        var user = await users.FindByNameAsync(request.UserName ?? string.Empty);
        var code = user is null ? null : await codes.FindAsync(request.Code, user.Id, cancellationToken);
        if (user is null || code is null)
        {
            await audit.AppendAsync(
                new AuditEntry("device.enroll", AuditResult.Failed, user?.Id, PeerUid: peer, Target: request.UserName),
                cancellationToken);
            return Refuse(AuthErrorCode.EnrollmentCodeInvalid, "That enrollment code is wrong, used or expired.");
        }

        if (CoreIdentity.IsDisabled(user))
        {
            return Refuse(AuthErrorCode.LockedOut, CoreIdentity.DisabledMessage);
        }

        if (await users.IsLockedOutAsync(user))
        {
            var until = (await users.GetLockoutEndDateAsync(user))?.ToUnixTimeMilliseconds();
            return Refuse(AuthErrorCode.LockedOut, "Too many wrong attempts. This account is locked for 15 minutes.", lockedOutUntil: until);
        }

        if (string.IsNullOrEmpty(request.Password)
            || request.Password.Length > MaxPasswordLength
            || !await users.CheckPasswordAsync(user, request.Password))
        {
            await users.AccessFailedAsync(user);
            await audit.AppendAsync(
                new AuditEntry("device.enroll", AuditResult.Failed, user.Id, PeerUid: peer, Target: user.UserName),
                cancellationToken);
            return Refuse(AuthErrorCode.InvalidCredentials, "The password is wrong.");
        }

        var publicKey = DeviceKeys.ParsePublicKey(request.PublicKey);
        var name = request.DeviceName?.Trim() ?? string.Empty;
        if (publicKey is null || name.Length is 0 or > 100)
        {
            return Refuse(AuthErrorCode.KeyInvalid, "The device key or name is not valid.", StatusCodes.Status400BadRequest);
        }

        await users.ResetAccessFailedCountAsync(user);
        var now = time.GetUtcNow().ToUnixTimeMilliseconds();
        code.RedeemedAt = now;
        var device = new Device
        {
            Id = Guid.NewGuid(),
            UserId = user.Id,
            Name = name,
            PublicKey = publicKey,
            CreatedAt = now,
        };
        db.Devices.Add(device);
        await db.SaveChangesAsync(cancellationToken);
        await audit.AppendAsync(
            new AuditEntry(
                "device.enroll",
                AuditResult.Success,
                user.Id,
                device.Id,
                peer,
                user.UserName,
                new Dictionary<string, string?> { ["deviceName"] = name }),
            cancellationToken);
        return TypedResults.Ok(new EnrollResponse(device.Id));
    }

    private static async Task<SignedInResponse> SignedInAsync(
        UserManager<CoreUser> users,
        AccessTokens tokens,
        CoreUser user,
        Device device,
        Guid sessionId)
    {
        var (token, expiresAt) = tokens.Issue(sessionId, user.Id, device.Id);
        var roles = (await users.GetRolesAsync(user)).Order(StringComparer.Ordinal).ToArray();
        return new SignedInResponse(
            sessionId,
            token,
            expiresAt,
            new SignedInUser(user.Id, user.UserName ?? string.Empty, roles, await users.GetTwoFactorEnabledAsync(user)));
    }

    /// <summary>A 64-byte P1363 signature in base64 or base64url, or null.</summary>
    private static byte[]? Signature(string? encoded)
    {
        if (string.IsNullOrEmpty(encoded) || encoded.Length > 200)
        {
            return null;
        }

        try
        {
            var bytes = encoded.Contains('+', StringComparison.Ordinal) || encoded.Contains('/', StringComparison.Ordinal) || encoded.EndsWith('=')
                ? Convert.FromBase64String(encoded)
                : Base64Url.DecodeFromChars(encoded);
            return bytes.Length == 64 ? bytes : null;
        }
        catch (FormatException)
        {
            return null;
        }
    }
}
