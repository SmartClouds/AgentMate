using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;
using Runova.Website.Core.Identity;
using Runova.Website.Data;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Users;

public sealed class InvitationTests : IDisposable
{
    private const string Users = "/api/v1/users";
    private const string PasswordSetups = "/api/v1/password-setups";
    private const string LinkStart = "https://runovahq.com/admin/set-password#token=";
    private const string NewPassword = "a brand new passphrase";

    private readonly FakeTimeProvider _time = new(new DateTimeOffset(DateTimeOffset.UtcNow.Ticks / TimeSpan.TicksPerMillisecond * TimeSpan.TicksPerMillisecond, TimeSpan.Zero));
    private readonly WebsiteApiFactory _factory;

    public InvitationTests(PostgresFixture postgres) => _factory = new(postgres.ConnectionString, time: _time);

    public void Dispose() => _factory.Dispose();

    [Fact]
    public async Task Inviting_returns_201_with_a_location_and_a_link_that_works_once()
    {
        var admin = await AdminClientAsync();
        var email = NewEmail();

        var response = await admin.SendAsync(HttpMethod.Post, Users, new { email, displayName = "New Editor", roles = new[] { "Editor" } });

        var body = await ApiClient.ReadJsonAsync(response, HttpStatusCode.Created);
        Assert.Equal(["user", "setupLink"], body.EnumerateObject().Select(p => p.Name));
        var user = body.GetProperty("user");
        var id = user.GetProperty("id").GetInt64();
        Assert.Equal($"{Users}/{id}", response.Headers.Location?.OriginalString);
        Assert.Equal(email, user.GetProperty("email").GetString());
        Assert.Equal("New Editor", user.GetProperty("displayName").GetString());
        Assert.False(user.GetProperty("emailConfirmed").GetBoolean());
        var link = body.GetProperty("setupLink");
        Assert.Equal(["url", "expiresAt"], link.EnumerateObject().Select(p => p.Name));
        Assert.Equal(_time.GetUtcNow().AddHours(24), link.GetProperty("expiresAt").GetDateTimeOffset());
        Assert.EndsWith("Z", link.GetProperty("expiresAt").GetString(), StringComparison.Ordinal);
        var token = TokenOf(link);
        Assert.Equal(32, Base64UrlDecode(token).Length);

        Assert.Equal(HttpStatusCode.NoContent, (await SetPasswordAsync(token, NewPassword)).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await _factory.CreateApiClient().SignInAsync(email, NewPassword)).StatusCode);
        var me = await ApiClient.ReadJsonAsync(await admin.GetAsync($"{Users}/{id}"), HttpStatusCode.OK);
        Assert.True(me.GetProperty("emailConfirmed").GetBoolean());

        await ProblemAssert.IsProblemAsync(
            await SetPasswordAsync(token, "yet another passphrase"), HttpStatusCode.NotFound, ProblemAssert.Type("not-found"), PasswordSetups);
        Assert.Equal(HttpStatusCode.NoContent, (await _factory.CreateApiClient().SignInAsync(email, NewPassword)).StatusCode);
    }

    [Fact]
    public async Task A_link_expires_after_24_hours()
    {
        var admin = await AdminClientAsync();
        var early = TokenOf((await InviteAsync(admin)).GetProperty("setupLink"));
        var late = TokenOf((await InviteAsync(admin)).GetProperty("setupLink"));

        _time.Advance(TimeSpan.FromHours(24) - TimeSpan.FromSeconds(1));
        Assert.Equal(HttpStatusCode.NoContent, (await SetPasswordAsync(early, NewPassword)).StatusCode);

        _time.Advance(TimeSpan.FromSeconds(1));
        await ProblemAssert.IsProblemAsync(
            await SetPasswordAsync(late, NewPassword), HttpStatusCode.NotFound, ProblemAssert.Type("not-found"), PasswordSetups);
    }

    [Fact]
    public async Task The_token_is_stored_only_as_its_sha256()
    {
        var admin = await AdminClientAsync();
        var invited = await InviteAsync(admin);
        var token = TokenOf(invited.GetProperty("setupLink"));
        var id = invited.GetProperty("user").GetProperty("id").GetInt64();

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var stored = await db.SetupLinks.AsNoTracking().SingleAsync(l => l.UserId == id, TestContext.Current.CancellationToken);
        Assert.Equal(SHA256.HashData(Encoding.ASCII.GetBytes(token)), stored.TokenHash);
        Assert.DoesNotContain(token, JsonSerializer.Serialize(stored), StringComparison.Ordinal);
    }

    [Fact]
    public async Task An_unknown_token_answers_404()
    {
        await ProblemAssert.IsProblemAsync(
            await SetPasswordAsync("bm90IGEgcmVhbCB0b2tlbiBhdCBhbGwsIG5vdCBvbmUh", NewPassword),
            HttpStatusCode.NotFound,
            ProblemAssert.Type("not-found"),
            PasswordSetups);
    }

    [Fact]
    public async Task A_short_password_answers_400_and_leaves_the_link_working()
    {
        var admin = await AdminClientAsync();
        var token = TokenOf((await InviteAsync(admin)).GetProperty("setupLink"));

        var problem = await ProblemAssert.IsProblemAsync(
            await SetPasswordAsync(token, "short"), HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), PasswordSetups);

        Assert.True(problem.GetProperty("errors").TryGetProperty("password", out _));
        Assert.Equal(HttpStatusCode.NoContent, (await SetPasswordAsync(token, NewPassword)).StatusCode);
    }

    [Fact]
    public async Task Setting_a_password_needs_the_antiforgery_header()
    {
        var admin = await AdminClientAsync();
        var token = TokenOf((await InviteAsync(admin)).GetProperty("setupLink"));
        var client = _factory.CreateApiClient();

        var response = await client.SendAsync(HttpMethod.Post, PasswordSetups, new { token, password = NewPassword }, antiforgeryToken: "");

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), PasswordSetups);
    }

    [Fact]
    public async Task A_taken_email_answers_409()
    {
        var admin = await AdminClientAsync();
        var existing = await TestUsers.CreateAsync(_factory.Services);

        var response = await admin.SendAsync(
            HttpMethod.Post, Users, new { email = existing.Email!.ToUpperInvariant(), displayName = "Twin", roles = new[] { "Editor" } });

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.Conflict, ProblemAssert.Type("conflict"), Users);
    }

    [Theory]
    [InlineData("""{"email":"not-an-email","displayName":"A","roles":["Editor"]}""", "email")]
    [InlineData("""{"email":"a@runovahq.com","displayName":"","roles":["Editor"]}""", "displayName")]
    [InlineData("""{"email":"a@runovahq.com","displayName":"A","roles":[]}""", "roles")]
    [InlineData("""{"email":"a@runovahq.com","displayName":"A","roles":["Owner"]}""", "roles")]
    public async Task A_bad_invitation_answers_400(string json, string field)
    {
        var admin = await AdminClientAsync();

        var response = await admin.SendAsync(HttpMethod.Post, Users, JsonDocument.Parse(json).RootElement);

        var problem = await ProblemAssert.IsProblemAsync(response, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), Users);
        Assert.True(problem.GetProperty("errors").TryGetProperty(field, out _));
    }

    [Fact]
    public async Task An_unknown_property_in_an_invitation_answers_400()
    {
        var admin = await AdminClientAsync();

        var response = await admin.SendAsync(
            HttpMethod.Post, Users, new { email = NewEmail(), displayName = "A", roles = new[] { "Editor" }, password = "nope nope nope" });

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), Users);
    }

    [Fact]
    public async Task A_new_invitation_replaces_the_old_link_and_answers_409_once_accepted()
    {
        var admin = await AdminClientAsync();
        var invited = await InviteAsync(admin);
        var id = invited.GetProperty("user").GetProperty("id").GetInt64();
        var old = TokenOf(invited.GetProperty("setupLink"));
        var path = $"{Users}/{id}/invitations";

        var renewed = await ApiClient.ReadJsonAsync(await admin.SendAsync(HttpMethod.Post, path), HttpStatusCode.Created);

        Assert.Equal(HttpStatusCode.NotFound, (await SetPasswordAsync(old, NewPassword)).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await SetPasswordAsync(TokenOf(renewed), NewPassword)).StatusCode);
        await ProblemAssert.IsProblemAsync(await admin.SendAsync(HttpMethod.Post, path), HttpStatusCode.Conflict, ProblemAssert.Type("conflict"), path);
    }

    [Fact]
    public async Task A_password_reset_link_sets_a_new_password()
    {
        var admin = await AdminClientAsync();
        var user = await TestUsers.CreateAsync(_factory.Services);

        var response = await admin.SendAsync(HttpMethod.Post, $"{Users}/{user.Id}/password-resets");

        var link = await ApiClient.ReadJsonAsync(response, HttpStatusCode.Created);
        Assert.Equal(_time.GetUtcNow().AddHours(24), link.GetProperty("expiresAt").GetDateTimeOffset());
        Assert.Equal(HttpStatusCode.NoContent, (await SetPasswordAsync(TokenOf(link), NewPassword)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await _factory.CreateApiClient().SignInAsync(user.Email!, TestUsers.Password)).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await _factory.CreateApiClient().SignInAsync(user.Email!, NewPassword)).StatusCode);
    }

    private async Task<ApiClient> AdminClientAsync() =>
        await TestUsers.SignedInClientAsync(_factory, await TestUsers.CreateAsync(_factory.Services, Roles.Admin));

    private static async Task<JsonElement> InviteAsync(ApiClient admin) =>
        await ApiClient.ReadJsonAsync(
            await admin.SendAsync(HttpMethod.Post, Users, new { email = NewEmail(), displayName = "Invited", roles = new[] { "Editor" } }),
            HttpStatusCode.Created);

    private async Task<HttpResponseMessage> SetPasswordAsync(string token, string password)
    {
        var client = _factory.CreateApiClient();
        await client.RefreshAntiforgeryTokenAsync();
        return await client.SendAsync(HttpMethod.Post, PasswordSetups, new { token, password });
    }

    private static string TokenOf(JsonElement setupLink)
    {
        var url = setupLink.GetProperty("url").GetString()!;
        Assert.StartsWith(LinkStart, url, StringComparison.Ordinal);
        return url[LinkStart.Length..];
    }

    private static byte[] Base64UrlDecode(string value) => System.Buffers.Text.Base64Url.DecodeFromChars(value);

    private static string NewEmail() => $"{Guid.NewGuid():N}@invited.runovahq.com";
}
