using System.Globalization;
using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;
using Runova.Website.Core.Identity;
using Runova.Website.Data.Identity;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Users;

public sealed class UsersTests : IDisposable
{
    private const string Users = "/api/v1/users";

    // The properties of the contract's UserDto, and nothing else.
    private static readonly string[] _userDtoProperties =
    [
        "id", "email", "displayName", "roles", "disabled", "emailConfirmed", "twoFactorEnabled",
        "lockedOutUntil", "lastSignInAt", "createdAt", "version",
    ];

    private readonly FakeTimeProvider _time = new(DateTimeOffset.UtcNow);
    private readonly WebsiteApiFactory _factory;

    public UsersTests(PostgresFixture postgres) => _factory = new(postgres.ConnectionString, time: _time);

    public void Dispose() => _factory.Dispose();

    [Fact]
    public async Task An_editor_gets_403_on_every_users_route_except_me()
    {
        var routes = _factory.Services.GetRequiredService<EndpointDataSource>().Endpoints
            .OfType<RouteEndpoint>()
            .Where(e => e.RoutePattern.RawText!.StartsWith(Users, StringComparison.Ordinal)
                && !e.RoutePattern.RawText.StartsWith(Users + "/me", StringComparison.Ordinal))
            .SelectMany(e => e.Metadata.GetMetadata<HttpMethodMetadata>()!.HttpMethods
                .Select(method => (Method: method, Path: e.RoutePattern.RawText!.Replace("{id:long}", "1", StringComparison.Ordinal))))
            .ToList();
        Assert.Equal(8, routes.Count);
        var editor = await TestUsers.SignedInClientAsync(_factory, await TestUsers.CreateAsync(_factory.Services));

        foreach (var (method, path) in routes)
        {
            var response = await editor.SendAsync(new HttpMethod(method), path, ifMatch: "\"1\"");

            await ProblemAssert.IsProblemAsync(response, HttpStatusCode.Forbidden, ProblemAssert.Type("forbidden"), path);
        }

        Assert.Equal(HttpStatusCode.OK, (await editor.GetAsync(Users + "/me")).StatusCode);
    }

    [Fact]
    public async Task An_admin_gets_a_user_with_its_etag_and_only_the_contract_fields()
    {
        var admin = await AdminClientAsync();
        var user = await TestUsers.CreateAsync(_factory.Services);

        var response = await admin.GetAsync($"{Users}/{user.Id}");

        var dto = await ApiClient.ReadJsonAsync(response, HttpStatusCode.OK);
        Assert.Equal(_userDtoProperties, dto.EnumerateObject().Select(p => p.Name));
        Assert.Equal(user.Id, dto.GetProperty("id").GetInt64());
        Assert.Equal(user.Email, dto.GetProperty("email").GetString());
        Assert.Equal(["Editor"], dto.GetProperty("roles").EnumerateArray().Select(r => r.GetString()));
        Assert.Equal($"\"{dto.GetProperty("version").GetString()}\"", response.Headers.ETag?.ToString());
    }

    [Fact]
    public async Task An_unknown_user_answers_404()
    {
        var admin = await AdminClientAsync();

        var response = await admin.GetAsync($"{Users}/999999999");

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.NotFound, ProblemAssert.Type("not-found"), $"{Users}/999999999");
    }

    [Fact]
    public async Task The_list_pages_with_the_contract_metadata_and_link_header()
    {
        var admin = await AdminClientAsync();
        var marker = NewMarker();
        for (var i = 0; i < 3; i++)
        {
            await TestUsers.CreateAsync(_factory.Services, displayName: $"{marker} {i}");
        }

        var first = await admin.GetAsync($"{Users}?q={marker}&pageSize=2");

        var page = await ApiClient.ReadJsonAsync(first, HttpStatusCode.OK);
        Assert.Equal(["items", "page", "pageSize", "totalItems", "totalPages"], page.EnumerateObject().Select(p => p.Name));
        Assert.Equal(2, page.GetProperty("items").GetArrayLength());
        Assert.Equal(1, page.GetProperty("page").GetInt32());
        Assert.Equal(2, page.GetProperty("pageSize").GetInt32());
        Assert.Equal(3, page.GetProperty("totalItems").GetInt32());
        Assert.Equal(2, page.GetProperty("totalPages").GetInt32());
        var links = Links(first);
        Assert.Equal($"{Users}?q={marker}&pageSize=2&page=1", links["first"]);
        Assert.Equal($"{Users}?q={marker}&pageSize=2&page=2", links["next"]);
        Assert.Equal($"{Users}?q={marker}&pageSize=2&page=2", links["last"]);
        Assert.False(links.ContainsKey("prev"));

        var second = await admin.GetAsync($"{Users}?q={marker}&pageSize=2&page=2");

        Assert.Equal(1, (await ApiClient.ReadJsonAsync(second, HttpStatusCode.OK)).GetProperty("items").GetArrayLength());
        Assert.Equal($"{Users}?q={marker}&pageSize=2&page=1", Links(second)["prev"]);
        Assert.False(Links(second).ContainsKey("next"));

        var past = await ApiClient.ReadJsonAsync(await admin.GetAsync($"{Users}?q={marker}&pageSize=2&page=5"), HttpStatusCode.OK);
        Assert.Equal(0, past.GetProperty("items").GetArrayLength());
        Assert.Equal(5, past.GetProperty("page").GetInt32());
    }

    [Fact]
    public async Task The_list_defaults_to_page_1_of_20()
    {
        var admin = await AdminClientAsync();

        var page = await ApiClient.ReadJsonAsync(await admin.GetAsync(Users), HttpStatusCode.OK);

        Assert.Equal(1, page.GetProperty("page").GetInt32());
        Assert.Equal(20, page.GetProperty("pageSize").GetInt32());
        Assert.InRange(page.GetProperty("items").GetArrayLength(), 1, 20);
    }

    [Theory]
    [InlineData("pageSize=101", "pageSize")]
    [InlineData("pageSize=0", "pageSize")]
    [InlineData("page=0", "page")]
    [InlineData("role=Owner", "role")]
    public async Task A_query_out_of_range_answers_400(string query, string field)
    {
        var admin = await AdminClientAsync();

        var response = await admin.GetAsync($"{Users}?{query}");

        var problem = await ProblemAssert.IsProblemAsync(response, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), Users);
        Assert.True(problem.GetProperty("errors").TryGetProperty(field, out _));
    }

    [Fact]
    public async Task The_page_size_may_be_100()
    {
        var admin = await AdminClientAsync();

        var page = await ApiClient.ReadJsonAsync(await admin.GetAsync($"{Users}?pageSize=100"), HttpStatusCode.OK);

        Assert.Equal(100, page.GetProperty("pageSize").GetInt32());
    }

    [Fact]
    public async Task q_matches_the_email_or_the_name_in_any_case()
    {
        var admin = await AdminClientAsync();
        var marker = NewMarker();
        var byName = await TestUsers.CreateAsync(_factory.Services, displayName: $"Pat {marker}");
        var other = await TestUsers.CreateAsync(_factory.Services);

        Assert.Equal([byName.Id], await IdsAsync(admin, $"{Users}?q={marker.ToUpperInvariant()}"));
        Assert.Equal([other.Id], await IdsAsync(admin, $"{Users}?q={other.Email![..12]}"));
        Assert.Empty(await IdsAsync(admin, $"{Users}?q={marker}%25"));
    }

    [Fact]
    public async Task role_and_disabled_filter_the_list()
    {
        var admin = await AdminClientAsync();
        var marker = NewMarker();
        var editor = await TestUsers.CreateAsync(_factory.Services, displayName: marker);
        var otherAdmin = await TestUsers.CreateAsync(_factory.Services, Roles.Admin, displayName: marker);
        var disabled = await TestUsers.CreateAsync(_factory.Services, displayName: marker);
        await PatchAsync(admin, disabled.Id, new { disabled = true });

        Assert.Equal([otherAdmin.Id], await IdsAsync(admin, $"{Users}?q={marker}&role=Admin"));
        Assert.Equal([editor.Id, disabled.Id], await IdsAsync(admin, $"{Users}?q={marker}&role=Editor"));
        Assert.Equal([disabled.Id], await IdsAsync(admin, $"{Users}?q={marker}&disabled=true"));
        Assert.Equal([editor.Id, otherAdmin.Id], await IdsAsync(admin, $"{Users}?q={marker}&disabled=false"));
    }

    [Fact]
    public async Task Patch_changes_the_name_roles_and_disabled_flag_and_returns_the_new_etag()
    {
        var admin = await AdminClientAsync();
        var user = await TestUsers.CreateAsync(_factory.Services);
        var etag = await ETagAsync(admin, user.Id);

        var response = await admin.SendAsync(
            HttpMethod.Patch, $"{Users}/{user.Id}", new { displayName = "Renamed", roles = new[] { "Admin", "Editor" }, disabled = true }, ifMatch: etag);

        var dto = await ApiClient.ReadJsonAsync(response, HttpStatusCode.OK);
        Assert.Equal("Renamed", dto.GetProperty("displayName").GetString());
        Assert.Equal(["Admin", "Editor"], dto.GetProperty("roles").EnumerateArray().Select(r => r.GetString()));
        Assert.True(dto.GetProperty("disabled").GetBoolean());
        Assert.NotEqual(etag, response.Headers.ETag?.ToString());
        Assert.Equal($"\"{dto.GetProperty("version").GetString()}\"", response.Headers.ETag?.ToString());
        Assert.Equal(response.Headers.ETag?.ToString(), await ETagAsync(admin, user.Id));
    }

    [Fact]
    public async Task Patch_leaves_out_fields_it_does_not_name()
    {
        var admin = await AdminClientAsync();
        var user = await TestUsers.CreateAsync(_factory.Services, displayName: "Kept");

        var dto = await PatchAsync(admin, user.Id, new { disabled = true });

        Assert.Equal("Kept", dto.GetProperty("displayName").GetString());
        Assert.Equal(["Editor"], dto.GetProperty("roles").EnumerateArray().Select(r => r.GetString()));
    }

    [Fact]
    public async Task A_write_without_if_match_answers_428()
    {
        var admin = await AdminClientAsync();
        var user = await TestUsers.CreateAsync(_factory.Services);
        var path = $"{Users}/{user.Id}";

        await ProblemAssert.IsProblemAsync(
            await admin.SendAsync(HttpMethod.Patch, path, new { displayName = "x" }),
            HttpStatusCode.PreconditionRequired,
            ProblemAssert.Type("precondition-required"),
            path);
        await ProblemAssert.IsProblemAsync(
            await admin.SendAsync(HttpMethod.Delete, path),
            HttpStatusCode.PreconditionRequired,
            ProblemAssert.Type("precondition-required"),
            path);
    }

    [Fact]
    public async Task A_stale_if_match_answers_412_with_the_current_version()
    {
        var admin = await AdminClientAsync();
        var user = await TestUsers.CreateAsync(_factory.Services);
        var path = $"{Users}/{user.Id}";
        var stale = await ETagAsync(admin, user.Id);
        await PatchAsync(admin, user.Id, new { displayName = "First" });
        var current = await ETagAsync(admin, user.Id);

        var response = await admin.SendAsync(HttpMethod.Patch, path, new { displayName = "Second" }, ifMatch: stale);

        var problem = await ProblemAssert.IsProblemAsync(response, HttpStatusCode.PreconditionFailed, ProblemAssert.Type("precondition-failed"), path);
        Assert.Equal(current, $"\"{problem.GetProperty("currentVersion").GetString()}\"");
        await ProblemAssert.IsProblemAsync(
            await admin.SendAsync(HttpMethod.Delete, path, ifMatch: stale),
            HttpStatusCode.PreconditionFailed,
            ProblemAssert.Type("precondition-failed"),
            path);
    }

    [Theory]
    [InlineData("""{"displayName":""}""", "displayName")]
    [InlineData("""{"displayName":null}""", "displayName")]
    [InlineData("""{"roles":[]}""", "roles")]
    [InlineData("""{"roles":["Owner"]}""", "roles")]
    [InlineData("""{"disabled":"yes"}""", "disabled")]
    [InlineData("""{"email":"new@runovahq.com"}""", "email")]
    public async Task A_bad_patch_answers_400(string json, string field)
    {
        var admin = await AdminClientAsync();
        var user = await TestUsers.CreateAsync(_factory.Services);
        var path = $"{Users}/{user.Id}";

        var response = await admin.SendAsync(HttpMethod.Patch, path, JsonDocument.Parse(json).RootElement, ifMatch: await ETagAsync(admin, user.Id));

        var problem = await ProblemAssert.IsProblemAsync(response, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), path);
        Assert.True(problem.GetProperty("errors").TryGetProperty(field, out _));
    }

    [Fact]
    public async Task Disabling_a_user_ends_their_sessions()
    {
        var admin = await AdminClientAsync();
        var user = await TestUsers.CreateAsync(_factory.Services);
        var session = await TestUsers.SignedInClientAsync(_factory, user);

        await PatchAsync(admin, user.Id, new { disabled = true });
        _time.Advance(TimeSpan.FromMinutes(6));

        Assert.Equal(HttpStatusCode.Unauthorized, (await session.GetAsync(Users + "/me")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await _factory.CreateApiClient().SignInAsync(user.Email!, TestUsers.Password)).StatusCode);
    }

    [Fact]
    public async Task Delete_removes_the_user()
    {
        var admin = await AdminClientAsync();
        var user = await TestUsers.CreateAsync(_factory.Services);

        var response = await admin.SendAsync(HttpMethod.Delete, $"{Users}/{user.Id}", ifMatch: await ETagAsync(admin, user.Id));

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await admin.GetAsync($"{Users}/{user.Id}")).StatusCode);
    }

    [Theory]
    [InlineData("PATCH", "")]
    [InlineData("DELETE", "")]
    [InlineData("POST", "/password-resets")]
    [InlineData("DELETE", "/two-factor")]
    [InlineData("POST", "/invitations")]
    public async Task A_change_to_an_unknown_user_answers_404(string method, string suffix)
    {
        var admin = await AdminClientAsync();
        var path = $"{Users}/999999999{suffix}";

        var response = await admin.SendAsync(new HttpMethod(method), path, method == "PATCH" ? new { displayName = "x" } : null, ifMatch: "\"1\"");

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.NotFound, ProblemAssert.Type("not-found"), path);
    }

    [Fact]
    public async Task A_two_factor_reset_turns_it_off_and_removes_the_recovery_codes()
    {
        var admin = await AdminClientAsync();
        var user = await TestUsers.CreateAsync(_factory.Services);
        await TestUsers.EnableTwoFactorAsync(_factory.Services, user);
        await TestUsers.GenerateRecoveryCodesAsync(_factory.Services, user);

        var response = await admin.SendAsync(HttpMethod.Delete, $"{Users}/{user.Id}/two-factor");

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        using var scope = _factory.Services.CreateScope();
        var users = scope.ServiceProvider.GetRequiredService<UserManager<AppUser>>();
        var stored = (await users.FindByIdAsync(user.Id.ToString(CultureInfo.InvariantCulture)))!;
        Assert.False(stored.TwoFactorEnabled);
        Assert.Equal(0, await users.CountRecoveryCodesAsync(stored));
        Assert.Equal(HttpStatusCode.NoContent, (await _factory.CreateApiClient().SignInAsync(user.Email!, TestUsers.Password)).StatusCode);
    }

    private async Task<ApiClient> AdminClientAsync() =>
        await TestUsers.SignedInClientAsync(_factory, await TestUsers.CreateAsync(_factory.Services, Roles.Admin));

    private static async Task<string> ETagAsync(ApiClient admin, long id)
    {
        var response = await admin.GetAsync($"{Users}/{id}");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return response.Headers.ETag!.ToString();
    }

    private static async Task<JsonElement> PatchAsync(ApiClient admin, long id, object patch) =>
        await ApiClient.ReadJsonAsync(
            await admin.SendAsync(HttpMethod.Patch, $"{Users}/{id}", patch, ifMatch: await ETagAsync(admin, id)),
            HttpStatusCode.OK);

    private static async Task<IReadOnlyList<long>> IdsAsync(ApiClient admin, string path) =>
        [.. (await ApiClient.ReadJsonAsync(await admin.GetAsync(path), HttpStatusCode.OK))
            .GetProperty("items").EnumerateArray().Select(u => u.GetProperty("id").GetInt64())];

    private static string NewMarker() => "m" + Guid.NewGuid().ToString("N")[..12];

    // The Link header as rel to target, as in <...>; rel="next".
    private static Dictionary<string, string> Links(HttpResponseMessage response) =>
        string.Join(",", response.Headers.GetValues("Link"))
            .Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .Select(link => link.Split(';', StringSplitOptions.TrimEntries))
            .ToDictionary(parts => parts[1]["rel=\"".Length..^1], parts => parts[0][1..^1]);
}
