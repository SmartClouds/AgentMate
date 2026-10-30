using System.Globalization;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Identity;
using Runova.Website.Api.Identity;
using Runova.Website.Api.Problems;
using Runova.Website.Core.Problems;
using Runova.Website.Core.Users;
using Runova.Website.Data.Identity;

namespace Runova.Website.Api.Users;

public sealed record TwoFactorStatusDto(bool Enabled, int RecoveryCodesLeft);

public sealed record TwoFactorSetupDto(string SharedKey, string AuthenticatorUri);

public sealed record TwoFactorConfirmRequest(string? Code);

public sealed record RecoveryCodesDto(IReadOnlyList<string> RecoveryCodes);

/// <summary>The signed-in user and their two-factor setup.</summary>
internal static class MeEndpoints
{
    private const string Issuer = "Runova";
    private const int RecoveryCodeCount = 10;

    public static RouteGroupBuilder MapMe(this RouteGroupBuilder api)
    {
        var me = api.MapGroup("/users/me").RequireAuthorization(Policies.Staff);
        me.MapGet("", GetMeAsync);
        me.MapGet("/two-factor", GetTwoFactorAsync);
        me.MapPost("/two-factor", StartTwoFactorAsync);
        me.MapPut("/two-factor", ConfirmTwoFactorAsync);
        return api;
    }

    private static async Task<Results<Ok<UserDto>, UnauthorizedHttpResult>> GetMeAsync(
        HttpContext http, UserManager<AppUser> users, TimeProvider time)
    {
        if (await users.GetUserAsync(http.User) is not { } user)
        {
            return TypedResults.Unauthorized();
        }

        return TypedResults.Ok(await users.ToDtoAsync(user, time));
    }

    private static async Task<Results<Ok<TwoFactorStatusDto>, UnauthorizedHttpResult>> GetTwoFactorAsync(
        HttpContext http, UserManager<AppUser> users)
    {
        if (await users.GetUserAsync(http.User) is not { } user)
        {
            return TypedResults.Unauthorized();
        }

        return TypedResults.Ok(new TwoFactorStatusDto(user.TwoFactorEnabled, await users.CountRecoveryCodesAsync(user)));
    }

    /// <summary>
    /// Makes a new authenticator key. Two-factor stays off until a code from it is confirmed, and
    /// a user who has it on already must turn it off first, so a running setup is never replaced.
    /// </summary>
    private static async Task<Results<Ok<TwoFactorSetupDto>, ProblemHttpResult, UnauthorizedHttpResult>> StartTwoFactorAsync(
        HttpContext http, UserManager<AppUser> users, SignInManager<AppUser> signIn)
    {
        if (await users.GetUserAsync(http.User) is not { } user)
        {
            return TypedResults.Unauthorized();
        }

        if (user.TwoFactorEnabled)
        {
            return ApiProblems.Of(ProblemTypes.Conflict, "Two-factor is on already. Turn it off before setting it up again.");
        }

        // A new key starts a new sequence of codes.
        user.LastTotpTimeStep = null;
        await users.ResetAuthenticatorKeyAsync(user);
        await signIn.RefreshSignInAsync(user);

        var key = (await users.GetAuthenticatorKeyAsync(user))!;
        var label = Uri.EscapeDataString($"{Issuer}:{user.Email}");
        var uri = string.Create(
            CultureInfo.InvariantCulture,
            $"otpauth://totp/{label}?secret={key}&issuer={Issuer}&digits=6&period=30");
        return TypedResults.Ok(new TwoFactorSetupDto(key, uri));
    }

    private static async Task<Results<Ok<RecoveryCodesDto>, ValidationProblem, UnauthorizedHttpResult>> ConfirmTwoFactorAsync(
        TwoFactorConfirmRequest request, HttpContext http, UserManager<AppUser> users, SignInManager<AppUser> signIn)
    {
        if (await users.GetUserAsync(http.User) is not { } user)
        {
            return TypedResults.Unauthorized();
        }

        if (string.IsNullOrWhiteSpace(request.Code)
            || !await users.VerifyTwoFactorTokenAsync(user, users.Options.Tokens.AuthenticatorTokenProvider, request.Code))
        {
            return ApiProblems.Invalid("code", "The code is not right. Enter the current code from your authenticator app.");
        }

        await users.SetTwoFactorEnabledAsync(user, true);
        var codes = await users.GenerateNewTwoFactorRecoveryCodesAsync(user, RecoveryCodeCount);
        await signIn.RefreshSignInAsync(user);
        return TypedResults.Ok(new RecoveryCodesDto([.. codes!]));
    }
}
