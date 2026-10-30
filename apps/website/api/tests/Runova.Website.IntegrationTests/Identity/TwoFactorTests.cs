using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.Time.Testing;
using Runova.Website.Core.Identity;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Identity;

public sealed class TwoFactorTests : IDisposable
{
    private const string Sessions = "/api/v1/sessions";
    private const string TwoFactor = "/api/v1/users/me/two-factor";

    // Five seconds into a time step, so a test knows which step "now" is.
    private readonly FakeTimeProvider _time = new(
        DateTimeOffset.FromUnixTimeSeconds((DateTimeOffset.UtcNow.ToUnixTimeSeconds() / 30 * 30) + 5));

    private readonly WebsiteApiFactory _factory;

    public TwoFactorTests(PostgresFixture postgres) => _factory = new(postgres.ConnectionString, time: _time);

    public void Dispose() => _factory.Dispose();

    [Fact]
    public async Task Setup_starts_with_a_shared_key_and_a_right_code_turns_it_on_with_ten_recovery_codes()
    {
        var client = await SignedInClientAsync(await TestUsers.CreateAsync(_factory.Services));

        var setup = await ReadJsonAsync(await client.SendAsync(HttpMethod.Post, TwoFactor));
        var key = Base32.Decode(setup.GetProperty("sharedKey").GetString()!);
        Assert.StartsWith("otpauth://totp/", setup.GetProperty("authenticatorUri").GetString(), StringComparison.Ordinal);
        Assert.False((await ReadJsonAsync(await client.GetAsync(TwoFactor))).GetProperty("enabled").GetBoolean());

        var confirmed = await client.SendAsync(HttpMethod.Put, TwoFactor, new { code = CodeNow(key) });

        Assert.Equal(HttpStatusCode.OK, confirmed.StatusCode);
        var recoveryCodes = (await ReadJsonAsync(confirmed)).GetProperty("recoveryCodes").EnumerateArray().Select(c => c.GetString()).ToList();
        Assert.Equal(10, recoveryCodes.Distinct().Count());
        var status = await ReadJsonAsync(await client.GetAsync(TwoFactor));
        Assert.True(status.GetProperty("enabled").GetBoolean());
        Assert.Equal(10, status.GetProperty("recoveryCodesLeft").GetInt32());
    }

    [Fact]
    public async Task A_wrong_code_does_not_turn_two_factor_on()
    {
        var client = await SignedInClientAsync(await TestUsers.CreateAsync(_factory.Services));
        var key = Base32.Decode((await ReadJsonAsync(await client.SendAsync(HttpMethod.Post, TwoFactor))).GetProperty("sharedKey").GetString()!);

        var response = await client.SendAsync(HttpMethod.Put, TwoFactor, new { code = Totp.Code(key, Totp.TimeStep(_time.GetUtcNow()) + 5) });

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), TwoFactor);
        Assert.False((await ReadJsonAsync(await client.GetAsync(TwoFactor))).GetProperty("enabled").GetBoolean());
    }

    [Fact]
    public async Task With_two_factor_on_the_password_alone_answers_two_factor_required()
    {
        var user = await TestUsers.CreateAsync(_factory.Services);
        await TestUsers.EnableTwoFactorAsync(_factory.Services, user);

        var response = await _factory.CreateApiClient().SignInAsync(user.Email!, TestUsers.Password);

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.Unauthorized, ProblemAssert.Type("two-factor-required"), Sessions);
    }

    [Fact]
    public async Task A_valid_code_signs_in_and_works_only_once()
    {
        var user = await TestUsers.CreateAsync(_factory.Services);
        var key = await TestUsers.EnableTwoFactorAsync(_factory.Services, user);
        var code = CodeNow(key);

        Assert.Equal(HttpStatusCode.NoContent, (await _factory.CreateApiClient().SignInAsync(user.Email!, TestUsers.Password, code)).StatusCode);
        var again = await _factory.CreateApiClient().SignInAsync(user.Email!, TestUsers.Password, code);

        await ProblemAssert.IsProblemAsync(again, HttpStatusCode.Unauthorized, ProblemAssert.Type("two-factor-required"), Sessions);

        // An earlier step's code is refused too once a later one was used.
        var earlier = Totp.Code(key, Totp.TimeStep(_time.GetUtcNow()) - 1);
        Assert.Equal(HttpStatusCode.Unauthorized, (await _factory.CreateApiClient().SignInAsync(user.Email!, TestUsers.Password, earlier)).StatusCode);

        _time.Advance(Totp.Step);
        Assert.Equal(HttpStatusCode.NoContent, (await _factory.CreateApiClient().SignInAsync(user.Email!, TestUsers.Password, CodeNow(key))).StatusCode);
    }

    [Fact]
    public async Task The_code_that_turned_two_factor_on_does_not_sign_in()
    {
        var client = await SignedInClientAsync(await TestUsers.CreateAsync(_factory.Services));
        var user = await ReadJsonAsync(await client.GetAsync("/api/v1/users/me"));
        var key = Base32.Decode((await ReadJsonAsync(await client.SendAsync(HttpMethod.Post, TwoFactor))).GetProperty("sharedKey").GetString()!);
        var code = CodeNow(key);
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(HttpMethod.Put, TwoFactor, new { code })).StatusCode);

        var response = await _factory.CreateApiClient().SignInAsync(user.GetProperty("email").GetString()!, TestUsers.Password, code);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task A_code_two_steps_off_is_refused()
    {
        var user = await TestUsers.CreateAsync(_factory.Services);
        var key = await TestUsers.EnableTwoFactorAsync(_factory.Services, user);

        var response = await _factory.CreateApiClient().SignInAsync(
            user.Email!, TestUsers.Password, Totp.Code(key, Totp.TimeStep(_time.GetUtcNow()) + 2));

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.Unauthorized, ProblemAssert.Type("two-factor-required"), Sessions);
    }

    [Fact]
    public async Task A_valid_code_with_a_wrong_password_answers_unauthorized()
    {
        var user = await TestUsers.CreateAsync(_factory.Services);
        var key = await TestUsers.EnableTwoFactorAsync(_factory.Services, user);

        var response = await _factory.CreateApiClient().SignInAsync(user.Email!, "not the password at all", CodeNow(key));

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.Unauthorized, ProblemAssert.Type("unauthorized"), Sessions);
    }

    [Fact]
    public async Task A_recovery_code_signs_in_once()
    {
        var user = await TestUsers.CreateAsync(_factory.Services);
        await TestUsers.EnableTwoFactorAsync(_factory.Services, user);
        var recoveryCode = (await TestUsers.GenerateRecoveryCodesAsync(_factory.Services, user))[0];

        var first = await _factory.CreateApiClient().SignInAsync(user.Email!, TestUsers.Password, recoveryCode: recoveryCode);
        var second = await _factory.CreateApiClient().SignInAsync(user.Email!, TestUsers.Password, recoveryCode: recoveryCode);

        Assert.Equal(HttpStatusCode.NoContent, first.StatusCode);
        await ProblemAssert.IsProblemAsync(second, HttpStatusCode.Unauthorized, ProblemAssert.Type("two-factor-required"), Sessions);
    }

    private string CodeNow(byte[] key) => Totp.Code(key, Totp.TimeStep(_time.GetUtcNow()));

    private async Task<ApiClient> SignedInClientAsync(Runova.Website.Data.Identity.AppUser user)
    {
        var client = _factory.CreateApiClient();
        Assert.Equal(HttpStatusCode.NoContent, (await client.SignInAsync(user.Email!, TestUsers.Password)).StatusCode);
        return client;
    }

    private static async Task<JsonElement> ReadJsonAsync(HttpResponseMessage response)
    {
        Assert.True(response.IsSuccessStatusCode, $"{(int)response.StatusCode}: {await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken)}");
        return await response.Content.ReadFromJsonAsync<JsonElement>(TestContext.Current.CancellationToken);
    }
}
