using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;

namespace Runova.ServerCore.Tests;

/// <summary>
/// Signing in: a single-use challenge, signed by an enrolled device key, plus the user's password
/// (and a TOTP code when two-factor is on). Renewal takes a fresh signature and no secret at all.
/// Each way it can fail says why in a code the app can act on, except that a wrong signature and a
/// wrong password read the same, so neither can be probed on its own.
/// </summary>
public sealed class AuthEndpointTests
{
    [Fact]
    public async Task A_signed_challenge_and_the_password_sign_the_device_in()
    {
        await using var harness = await AuthHarness.CreateAsync();

        var signedIn = await harness.SignInAsync();

        Assert.Equal("maria", signedIn.User.UserName);
        Assert.Equal(["owner"], signedIn.User.Roles);
        Assert.False(signedIn.User.TwoFactorEnabled);
        Assert.False(string.IsNullOrEmpty(signedIn.AccessToken));
        Assert.Equal(
            harness.Clock!.GetUtcNow().AddMinutes(15).ToUnixTimeMilliseconds(),
            signedIn.AccessTokenExpiresAtUnixMs);
    }

    [Fact]
    public async Task The_access_token_opens_the_hub()
    {
        await using var harness = await AuthHarness.CreateAsync();
        var signedIn = await harness.SignInAsync();
        await using var hub = harness.Hub(signedIn.AccessToken);

        await hub.StartAsync(TestContext.Current.CancellationToken);
        var pong = await hub.InvokeAsync<PingResponse>("Ping", TestContext.Current.CancellationToken);

        Assert.True(pong.ServerTimeUnixMs > 0);
    }

    [Fact]
    public async Task A_wrong_password_and_a_wrong_signature_read_the_same()
    {
        await using var harness = await AuthHarness.CreateAsync();
        var wrongPassword = await harness.LoginAsync(password: "not the password at all");

        var challenge = await harness.ChallengeAsync(AuthPurpose.Login);
        using var otherKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var wrongSignature = await harness.Client.PostAsJsonAsync(
            "/api/v1/auth/login",
            new LoginRequest(
                challenge.ChallengeId,
                harness.DeviceId,
                harness.Sign(challenge, AuthPurpose.Login, key: otherKey),
                "maria",
                AuthHarness.Password),
            CoreJson.Options,
            TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.Unauthorized, wrongPassword.StatusCode);
        Assert.Equal(AuthErrorCode.InvalidCredentials, await AuthHarness.ErrorOf(wrongPassword));
        Assert.Equal(HttpStatusCode.Unauthorized, wrongSignature.StatusCode);
        Assert.Equal(AuthErrorCode.InvalidCredentials, await AuthHarness.ErrorOf(wrongSignature));
    }

    [Fact]
    public async Task Five_wrong_passwords_lock_the_account_for_fifteen_minutes()
    {
        await using var harness = await AuthHarness.CreateAsync();
        for (var i = 0; i < 4; i++)
        {
            Assert.Equal(AuthErrorCode.InvalidCredentials, await AuthHarness.ErrorOf(await harness.LoginAsync(password: "wrong wrong wrong")));
        }

        var fifth = await harness.LoginAsync(password: "wrong wrong wrong");
        var afterwards = await harness.LoginAsync();

        Assert.Equal(AuthErrorCode.LockedOut, await AuthHarness.ErrorOf(fifth));
        var locked = (await afterwards.Content.ReadFromJsonAsync<AuthError>(CoreJson.Options, TestContext.Current.CancellationToken))!;
        Assert.Equal(AuthErrorCode.LockedOut, locked.Code);
        Assert.NotNull(locked.LockedOutUntilUnixMs);
        var remaining = DateTimeOffset.FromUnixTimeMilliseconds(locked.LockedOutUntilUnixMs!.Value) - DateTimeOffset.UtcNow;
        Assert.InRange(remaining, TimeSpan.FromMinutes(14), TimeSpan.FromMinutes(15));
    }

    [Fact]
    public async Task A_challenge_can_be_used_once_even_when_the_first_try_failed()
    {
        await using var harness = await AuthHarness.CreateAsync();
        var challenge = await harness.ChallengeAsync(AuthPurpose.Login);
        await harness.LoginAsync(password: "not the password at all", challenge: challenge);

        var replay = await harness.LoginAsync(challenge: challenge);

        Assert.Equal(AuthErrorCode.ChallengeInvalid, await AuthHarness.ErrorOf(replay));
    }

    [Fact]
    public async Task A_challenge_expires_after_a_minute()
    {
        await using var harness = await AuthHarness.CreateAsync();
        var challenge = await harness.ChallengeAsync(AuthPurpose.Login);

        harness.Clock!.Advance(TimeSpan.FromSeconds(61));
        var late = await harness.LoginAsync(challenge: challenge);

        Assert.Equal(AuthErrorCode.ChallengeInvalid, await AuthHarness.ErrorOf(late));
    }

    [Fact]
    public async Task A_renewal_challenge_cannot_be_spent_on_a_login()
    {
        await using var harness = await AuthHarness.CreateAsync();
        var signedIn = await harness.SignInAsync();
        var renewal = await harness.ChallengeAsync(AuthPurpose.Renew, signedIn.SessionId);

        var misuse = await harness.LoginAsync(challenge: renewal);

        Assert.Equal(AuthErrorCode.ChallengeInvalid, await AuthHarness.ErrorOf(misuse));
    }

    [Fact]
    public async Task Two_factor_asks_for_a_code_and_refuses_a_wrong_one()
    {
        await using var harness = await AuthHarness.CreateAsync(fakeClock: false);
        var key = await EnableTwoFactorAsync(harness);

        var withoutCode = await harness.LoginAsync();
        var wrongCode = await harness.LoginAsync(totpCode: "000000");
        var rightCode = await harness.LoginAsync(totpCode: AuthHarness.TotpCode(key));

        Assert.Equal(AuthErrorCode.TotpRequired, await AuthHarness.ErrorOf(withoutCode));
        Assert.Equal(AuthErrorCode.TotpInvalid, await AuthHarness.ErrorOf(wrongCode));
        Assert.True(rightCode.IsSuccessStatusCode, await rightCode.Content.ReadAsStringAsync(TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task A_recovery_code_stands_in_for_the_authenticator_once()
    {
        await using var harness = await AuthHarness.CreateAsync(fakeClock: false);
        await EnableTwoFactorAsync(harness);
        string code;
        await using (var scope = harness.Services.CreateAsyncScope())
        {
            var users = scope.ServiceProvider.GetRequiredService<UserManager<CoreUser>>();
            var maria = (await users.FindByNameAsync("maria"))!;
            code = (await users.GenerateNewTwoFactorRecoveryCodesAsync(maria, 1))!.Single();
        }

        var first = await harness.LoginAsync(recoveryCode: code);
        var second = await harness.LoginAsync(recoveryCode: code);

        Assert.True(first.IsSuccessStatusCode, await first.Content.ReadAsStringAsync(TestContext.Current.CancellationToken));
        Assert.Equal(AuthErrorCode.TotpInvalid, await AuthHarness.ErrorOf(second));
    }

    [Fact]
    public async Task An_authenticator_code_works_once()
    {
        await using var harness = await AuthHarness.CreateAsync();
        var key = await EnableTwoFactorAsync(harness);
        var code = harness.TotpCodeNow(key);

        var first = await harness.LoginAsync(totpCode: code);
        var again = await harness.LoginAsync(totpCode: code);

        Assert.True(first.IsSuccessStatusCode, await first.Content.ReadAsStringAsync(TestContext.Current.CancellationToken));
        Assert.Equal(AuthErrorCode.TotpInvalid, await AuthHarness.ErrorOf(again));
    }

    [Fact]
    public async Task A_code_older_than_one_already_used_is_spent_as_well()
    {
        await using var harness = await AuthHarness.CreateAsync();
        var key = await EnableTwoFactorAsync(harness);

        var next = await harness.LoginAsync(totpCode: harness.TotpCodeNow(key, stepsAway: 1));
        var current = await harness.LoginAsync(totpCode: harness.TotpCodeNow(key));

        Assert.True(next.IsSuccessStatusCode, await next.Content.ReadAsStringAsync(TestContext.Current.CancellationToken));
        Assert.Equal(AuthErrorCode.TotpInvalid, await AuthHarness.ErrorOf(current));
    }

    [Theory]
    [InlineData(-2, false)]
    [InlineData(-1, true)]
    [InlineData(0, true)]
    [InlineData(1, true)]
    [InlineData(2, false)]
    public async Task A_code_counts_for_one_step_either_side_of_now(int stepsAway, bool accepted)
    {
        await using var harness = await AuthHarness.CreateAsync();
        var key = await EnableTwoFactorAsync(harness);

        var response = await harness.LoginAsync(totpCode: harness.TotpCodeNow(key, stepsAway));

        Assert.Equal(accepted, response.IsSuccessStatusCode);
    }

    [Fact]
    public async Task One_code_sent_twice_at_the_same_moment_signs_in_once()
    {
        await using var harness = await AuthHarness.CreateAsync();
        var key = await EnableTwoFactorAsync(harness);
        var code = harness.TotpCodeNow(key);
        // Both challenges first, so nothing but the code stands between the two sign-ins.
        var (first, _) = await harness.TryChallengeAsync(AuthPurpose.Login);
        var (second, _) = await harness.TryChallengeAsync(AuthPurpose.Login);

        var responses = await Task.WhenAll(
            harness.LoginAsync(totpCode: code, challenge: first),
            harness.LoginAsync(totpCode: code, challenge: second));

        Assert.Single(responses, response => response.IsSuccessStatusCode);
    }

    [Fact]
    public async Task A_revoked_device_is_told_so_and_cannot_sign_in_or_renew()
    {
        await using var harness = await AuthHarness.CreateAsync();
        var signedIn = await harness.SignInAsync();
        await RevokeDeviceAsync(harness);

        var login = await harness.LoginAsync();
        var renew = await harness.RenewAsync(signedIn.SessionId);

        Assert.Equal(AuthErrorCode.DeviceRevoked, await AuthHarness.ErrorOf(login));
        Assert.Equal(AuthErrorCode.DeviceRevoked, await AuthHarness.ErrorOf(renew));
    }

    [Fact]
    public async Task A_revoked_device_is_turned_away_from_the_hub_at_once()
    {
        await using var harness = await AuthHarness.CreateAsync();
        var signedIn = await harness.SignInAsync();
        await RevokeDeviceAsync(harness);
        await using var hub = harness.Hub(signedIn.AccessToken);

        await Assert.ThrowsAnyAsync<Exception>(() => hub.StartAsync(TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task An_unknown_device_is_told_to_enroll()
    {
        await using var harness = await AuthHarness.CreateAsync();

        var challenge = await harness.Client.PostAsJsonAsync(
            "/api/v1/auth/challenge",
            new ChallengeRequest(Guid.NewGuid(), AuthPurpose.Login),
            CoreJson.Options,
            TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.Unauthorized, challenge.StatusCode);
        Assert.Equal(AuthErrorCode.DeviceUnknown, await AuthHarness.ErrorOf(challenge));
    }

    [Fact]
    public async Task Renewing_takes_a_signature_and_no_password()
    {
        await using var harness = await AuthHarness.CreateAsync();
        var signedIn = await harness.SignInAsync();
        harness.Clock!.Advance(TimeSpan.FromMinutes(14));

        var renewed = await harness.RenewAsync(signedIn.SessionId);

        Assert.True(renewed.IsSuccessStatusCode, await renewed.Content.ReadAsStringAsync(TestContext.Current.CancellationToken));
        var body = (await renewed.Content.ReadFromJsonAsync<SignedInResponse>(CoreJson.Options, TestContext.Current.CancellationToken))!;
        Assert.Equal(signedIn.SessionId, body.SessionId);
        Assert.Equal(harness.Clock.GetUtcNow().AddMinutes(15).ToUnixTimeMilliseconds(), body.AccessTokenExpiresAtUnixMs);
    }

    [Fact]
    public async Task A_session_left_unused_for_thirty_days_has_expired()
    {
        await using var harness = await AuthHarness.CreateAsync();
        var signedIn = await harness.SignInAsync();
        harness.Clock!.Advance(TimeSpan.FromDays(31));

        var renew = await harness.RenewAsync(signedIn.SessionId);

        Assert.Equal(AuthErrorCode.SessionExpired, await AuthHarness.ErrorOf(renew));
    }

    [Fact]
    public async Task No_session_outlives_its_absolute_limit_however_often_it_renews()
    {
        await using var harness = await AuthHarness.CreateAsync();
        var signedIn = await harness.SignInAsync();
        for (var day = 0; day < 180; day += 20)
        {
            harness.Clock!.Advance(TimeSpan.FromDays(20));
            var renewed = await harness.RenewAsync(signedIn.SessionId);
            if (!renewed.IsSuccessStatusCode)
            {
                Assert.Equal(AuthErrorCode.SessionExpired, await AuthHarness.ErrorOf(renewed));
                Assert.True(day >= 160, $"expired early, after {day + 20} days");
                return;
            }
        }

        Assert.Fail("The session outlived its 180 days.");
    }

    [Fact]
    public async Task A_password_reset_ends_every_session()
    {
        await using var harness = await AuthHarness.CreateAsync();
        var signedIn = await harness.SignInAsync();
        await using (var scope = harness.Services.CreateAsyncScope())
        {
            var users = scope.ServiceProvider.GetRequiredService<UserManager<CoreUser>>();
            var maria = (await users.FindByNameAsync("maria"))!;
            var token = await users.GeneratePasswordResetTokenAsync(maria);
            Assert.True((await users.ResetPasswordAsync(maria, token, "a brand new passphrase")).Succeeded);
        }

        var renew = await harness.RenewAsync(signedIn.SessionId);

        Assert.Equal(AuthErrorCode.SessionRevoked, await AuthHarness.ErrorOf(renew));
    }

    [Fact]
    public async Task An_expired_access_token_no_longer_opens_the_hub()
    {
        await using var harness = await AuthHarness.CreateAsync();
        var signedIn = await harness.SignInAsync();
        harness.Clock!.Advance(TimeSpan.FromMinutes(16));
        await using var hub = harness.Hub(signedIn.AccessToken);

        await Assert.ThrowsAnyAsync<Exception>(() => hub.StartAsync(TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task Every_sign_in_attempt_is_audited_without_its_secrets()
    {
        await using var harness = await AuthHarness.CreateAsync();
        await harness.LoginAsync(password: "not the password at all");
        await harness.SignInAsync();

        await using var scope = harness.Services.CreateAsyncScope();
        var events = await scope.ServiceProvider.GetRequiredService<CoreDbContext>()
            .AuditEvents.OrderBy(e => e.Id).ToListAsync(TestContext.Current.CancellationToken);

        Assert.Equal(["auth.login", "auth.login"], events.Select(e => e.Action));
        Assert.Equal(["failed", "success"], events.Select(e => e.Result));
        Assert.All(events, e => Assert.Equal(harness.DeviceId, e.DeviceId));
        Assert.DoesNotContain(events, e => (e.Parameters ?? "").Contains(AuthHarness.Password, StringComparison.Ordinal));
    }

    private static async Task<string> EnableTwoFactorAsync(AuthHarness harness)
    {
        await using var scope = harness.Services.CreateAsyncScope();
        var users = scope.ServiceProvider.GetRequiredService<UserManager<CoreUser>>();
        var maria = (await users.FindByNameAsync("maria"))!;
        await users.ResetAuthenticatorKeyAsync(maria);
        await users.SetTwoFactorEnabledAsync(maria, true);
        return (await users.GetAuthenticatorKeyAsync(maria))!;
    }

    private static async Task RevokeDeviceAsync(AuthHarness harness)
    {
        await using var scope = harness.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<CoreDbContext>();
        var device = await db.Devices.SingleAsync(d => d.Id == harness.DeviceId);
        device.RevokedAt = 1;
        await db.SaveChangesAsync();
    }
}
