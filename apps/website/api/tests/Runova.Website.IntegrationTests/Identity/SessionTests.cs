using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Identity;

public sealed class SessionTests(PostgresFixture postgres) : IDisposable
{
    private const string Sessions = "/api/v1/sessions";

    private readonly WebsiteApiFactory _factory = new(postgres.ConnectionString);

    public void Dispose() => _factory.Dispose();

    [Fact]
    public async Task Signing_in_with_the_right_password_answers_204_and_sets_the_session_cookie()
    {
        var user = await TestUsers.CreateAsync(_factory.Services);
        var client = _factory.CreateApiClient();

        var response = await client.SignInAsync(user.Email!, TestUsers.Password);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        var cookie = Assert.Single(SetCookies(response), c => c.StartsWith("__Host-runova-session=", StringComparison.Ordinal));
        var attributes = cookie.ToLowerInvariant();
        Assert.Contains("; httponly", attributes, StringComparison.Ordinal);
        Assert.Contains("; secure", attributes, StringComparison.Ordinal);
        Assert.Contains("; samesite=strict", attributes, StringComparison.Ordinal);
        Assert.Contains("; path=/", attributes, StringComparison.Ordinal);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/v1/users/me")).StatusCode);
    }

    [Fact]
    public async Task Signing_in_also_sets_a_readable_antiforgery_cookie()
    {
        var user = await TestUsers.CreateAsync(_factory.Services);

        var response = await _factory.CreateApiClient().SignInAsync(user.Email!, TestUsers.Password);

        var cookie = Assert.Single(SetCookies(response), c => c.StartsWith("XSRF-TOKEN=", StringComparison.Ordinal));
        Assert.DoesNotContain("httponly", cookie, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Users_me_answers_the_signed_in_user()
    {
        var user = await TestUsers.CreateAsync(_factory.Services);
        var client = _factory.CreateApiClient();
        await client.SignInAsync(user.Email!, TestUsers.Password);

        var me = await (await client.GetAsync("/api/v1/users/me")).Content.ReadFromJsonAsync<JsonElement>(TestContext.Current.CancellationToken);

        Assert.Equal(user.Id, me.GetProperty("id").GetInt64());
        Assert.Equal(user.Email, me.GetProperty("email").GetString());
        Assert.Equal("Test Editor", me.GetProperty("displayName").GetString());
        Assert.Equal(["Editor"], me.GetProperty("roles").EnumerateArray().Select(r => r.GetString()));
        Assert.False(me.GetProperty("disabled").GetBoolean());
        Assert.False(me.GetProperty("twoFactorEnabled").GetBoolean());
        Assert.Equal(JsonValueKind.Null, me.GetProperty("lockedOutUntil").ValueKind);
        Assert.Equal(JsonValueKind.String, me.GetProperty("lastSignInAt").ValueKind);
        Assert.False(string.IsNullOrEmpty(me.GetProperty("version").GetString()));
    }

    [Fact]
    public async Task A_wrong_password_answers_401_problem_details()
    {
        var user = await TestUsers.CreateAsync(_factory.Services);

        var response = await _factory.CreateApiClient().SignInAsync(user.Email!, "not the password at all");

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.Unauthorized, ProblemAssert.Type("unauthorized"), Sessions);
        Assert.DoesNotContain(SetCookies(response), c => c.StartsWith("__Host-runova-session=", StringComparison.Ordinal));
    }

    [Fact]
    public async Task An_unknown_email_answers_the_same_401_as_a_wrong_password()
    {
        var user = await TestUsers.CreateAsync(_factory.Services);
        var client = _factory.CreateApiClient();

        var wrongPassword = await ProblemAssert.IsProblemAsync(
            await client.SignInAsync(user.Email!, "not the password at all"), HttpStatusCode.Unauthorized, ProblemAssert.Type("unauthorized"), Sessions);
        var unknownEmail = await ProblemAssert.IsProblemAsync(
            await client.SignInAsync("nobody@test.runovahq.com", TestUsers.Password), HttpStatusCode.Unauthorized, ProblemAssert.Type("unauthorized"), Sessions);

        Assert.Equal(wrongPassword.GetProperty("detail").GetString(), unknownEmail.GetProperty("detail").GetString());
    }

    [Fact]
    public async Task Five_failures_lock_the_account_so_the_sixth_attempt_answers_423()
    {
        var user = await TestUsers.CreateAsync(_factory.Services);
        var client = _factory.CreateApiClient();
        for (var attempt = 1; attempt <= 5; attempt++)
        {
            Assert.Equal(HttpStatusCode.Unauthorized, (await client.SignInAsync(user.Email!, "not the password at all")).StatusCode);
        }

        var sixth = await client.SignInAsync(user.Email!, "not the password at all");

        var problem = await ProblemAssert.IsProblemAsync(sixth, (HttpStatusCode)423, ProblemAssert.Type("account-locked"), Sessions);
        Assert.InRange(problem.GetProperty("retryAfter").GetInt32(), 1, 15 * 60);

        // Locked means locked, the right password included.
        var rightPassword = await client.SignInAsync(user.Email!, TestUsers.Password);
        await ProblemAssert.IsProblemAsync(rightPassword, (HttpStatusCode)423, ProblemAssert.Type("account-locked"), Sessions);
    }

    [Fact]
    public async Task A_success_resets_the_failure_count()
    {
        var user = await TestUsers.CreateAsync(_factory.Services);
        var client = _factory.CreateApiClient();
        for (var attempt = 1; attempt <= 4; attempt++)
        {
            await client.SignInAsync(user.Email!, "not the password at all");
        }

        Assert.Equal(HttpStatusCode.NoContent, (await client.SignInAsync(user.Email!, TestUsers.Password)).StatusCode);

        var other = _factory.CreateApiClient();
        for (var attempt = 1; attempt <= 5; attempt++)
        {
            Assert.Equal(HttpStatusCode.Unauthorized, (await other.SignInAsync(user.Email!, "not the password at all")).StatusCode);
        }
    }

    [Fact]
    public async Task Signing_in_without_the_antiforgery_token_answers_400()
    {
        var user = await TestUsers.CreateAsync(_factory.Services);
        var client = _factory.CreateApiClient();

        var response = await client.SendAsync(HttpMethod.Post, Sessions, new { email = user.Email, password = TestUsers.Password }, antiforgeryToken: "");

        var problem = await ProblemAssert.IsProblemAsync(response, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), Sessions);
        Assert.True(problem.GetProperty("errors").TryGetProperty("antiforgery", out _));
    }

    [Fact]
    public async Task Signing_out_answers_204_clears_the_cookie_and_ends_the_session()
    {
        var user = await TestUsers.CreateAsync(_factory.Services);
        var client = _factory.CreateApiClient();
        await client.SignInAsync(user.Email!, TestUsers.Password);

        var response = await client.SendAsync(HttpMethod.Delete, Sessions + "/current");

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        var cleared = Assert.Single(SetCookies(response), c => c.StartsWith("__Host-runova-session=", StringComparison.Ordinal));
        Assert.Contains("expires=Thu, 01 Jan 1970", cleared, StringComparison.OrdinalIgnoreCase);
        await ProblemAssert.IsProblemAsync(
            await client.GetAsync("/api/v1/users/me"), HttpStatusCode.Unauthorized, ProblemAssert.Type("unauthorized"), "/api/v1/users/me");
    }

    private static IEnumerable<string> SetCookies(HttpResponseMessage response) =>
        response.Headers.TryGetValues("Set-Cookie", out var values) ? values : [];
}
