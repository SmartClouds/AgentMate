using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Identity;
using Runova.Website.Api.Identity;
using Runova.Website.Api.Problems;
using Runova.Website.Core.Problems;
using Runova.Website.Data.Identity;

namespace Runova.Website.Api.Sessions;

public sealed record SignInRequest(string? Email, string? Password, string? TwoFactorCode, string? RecoveryCode);

public sealed record CsrfTokenDto(string Token);

/// <summary>Staff sign-in and sign-out, and the antiforgery token the admin app sends back.</summary>
internal static class SessionEndpoints
{
    private const string WrongCredentials = "The email or password is not right.";

    public static RouteGroupBuilder MapSessions(this RouteGroupBuilder api)
    {
        api.MapGet("/csrf-tokens/current", GetCsrfToken).AllowAnonymous();
        api.MapPost("/sessions", SignInAsync).AllowAnonymous().WithMetadata(RequiresAntiforgery.Instance);
        api.MapDelete("/sessions/current", SignOutAsync).RequireAuthorization(Policies.Staff);
        return api;
    }

    private static Ok<CsrfTokenDto> GetCsrfToken(HttpContext http) => TypedResults.Ok(new CsrfTokenDto(AntiforgeryCheck.IssueToken(http)));

    private static async Task<Results<NoContent, ValidationProblem, ProblemHttpResult>> SignInAsync(
        SignInRequest request,
        UserManager<AppUser> users,
        SignInManager<AppUser> signIn,
        TimeProvider time,
        HttpContext http)
    {
        if (string.IsNullOrWhiteSpace(request.Email))
        {
            return ApiProblems.Invalid("email", "Enter an email.");
        }

        if (string.IsNullOrEmpty(request.Password))
        {
            return ApiProblems.Invalid("password", "Enter a password.");
        }

        var user = await users.FindByEmailAsync(request.Email);
        if (user is null || user.DisabledAt is not null)
        {
            // Hash anyway, so an unknown email takes as long as a wrong password.
            users.PasswordHasher.HashPassword(user ?? new AppUser(), request.Password);
            return ApiProblems.Of(ProblemTypes.Unauthorized, WrongCredentials);
        }

        if (await users.IsLockedOutAsync(user))
        {
            return Locked(user, time);
        }

        // Counts the failure; the fifth locks the account, and that attempt still answers 401.
        var password = await signIn.CheckPasswordSignInAsync(user, request.Password, lockoutOnFailure: true);
        if (!password.Succeeded)
        {
            return ApiProblems.Of(ProblemTypes.Unauthorized, WrongCredentials);
        }

        if (user.TwoFactorEnabled)
        {
            bool? verified = request switch
            {
                { TwoFactorCode: { Length: > 0 } code } =>
                    await users.VerifyTwoFactorTokenAsync(user, users.Options.Tokens.AuthenticatorTokenProvider, code),
                { RecoveryCode: { Length: > 0 } recoveryCode } =>
                    (await users.RedeemTwoFactorRecoveryCodeAsync(user, recoveryCode.Replace(" ", "", StringComparison.Ordinal))).Succeeded,
                _ => null,
            };

            if (verified is null)
            {
                return ApiProblems.Of(ProblemTypes.TwoFactorRequired, "Enter the code from your authenticator app, or a recovery code.");
            }

            if (verified is false)
            {
                await users.AccessFailedAsync(user);
                return ApiProblems.Of(ProblemTypes.TwoFactorRequired, "The code is not right or was already used.");
            }

            await users.ResetAccessFailedCountAsync(user);
        }

        user.LastSignInAt = time.GetUtcNow();
        await users.UpdateAsync(user);
        await signIn.SignInAsync(user, isPersistent: true);

        // The antiforgery token belongs to a user, so the one from before sign-in is replaced.
        http.User = await signIn.CreateUserPrincipalAsync(user);
        AntiforgeryCheck.IssueToken(http);
        return TypedResults.NoContent();
    }

    private static async Task<NoContent> SignOutAsync(SignInManager<AppUser> signIn)
    {
        await signIn.SignOutAsync();
        return TypedResults.NoContent();
    }

    private static ProblemHttpResult Locked(AppUser user, TimeProvider time)
    {
        var left = (user.LockoutEnd ?? time.GetUtcNow()) - time.GetUtcNow();
        var retryAfter = Math.Max(1, (int)Math.Ceiling(left.TotalSeconds));
        return ApiProblems.Of(
            ProblemTypes.AccountLocked,
            "Too many failed sign-ins in a row. Try again after retryAfter seconds.",
            new Dictionary<string, object?> { ["retryAfter"] = retryAfter });
    }
}
