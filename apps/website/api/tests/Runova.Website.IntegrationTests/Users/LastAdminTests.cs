using System.Net;
using Runova.Website.Core.Identity;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Users;

/// <summary>Each test has a database to itself, so it knows exactly which Admins exist.</summary>
public sealed class LastAdminTests(PostgresFixture postgres) : IAsyncLifetime
{
    private const string Users = "/api/v1/users";

    private WebsiteApiFactory _factory = null!;

    public async ValueTask InitializeAsync() => _factory = new(await postgres.CreateDatabaseAsync());

    public ValueTask DisposeAsync() => _factory.DisposeAsync();

    public static TheoryData<string, string?> Removals => new()
    {
        { "PATCH", """{"roles":["Editor"]}""" },
        { "PATCH", """{"disabled":true}""" },
        { "DELETE", null },
    };

    [Theory]
    [MemberData(nameof(Removals))]
    public async Task Removing_or_demoting_the_last_admin_answers_409(string method, string? patch)
    {
        var admin = await TestUsers.CreateAsync(_factory.Services, Roles.Admin);
        var client = await TestUsers.SignedInClientAsync(_factory, admin);
        var path = $"{Users}/{admin.Id}";

        var response = await SendAsync(client, method, path, patch);

        var problem = await ProblemAssert.IsProblemAsync(response, HttpStatusCode.Conflict, ProblemAssert.Type("conflict"), path);
        Assert.Contains("last Admin", problem.GetProperty("detail").GetString(), StringComparison.Ordinal);
        var stored = await ApiClient.ReadJsonAsync(await client.GetAsync(path), HttpStatusCode.OK);
        Assert.Equal(["Admin"], stored.GetProperty("roles").EnumerateArray().Select(r => r.GetString()));
        Assert.False(stored.GetProperty("disabled").GetBoolean());
    }

    [Theory]
    [MemberData(nameof(Removals))]
    public async Task A_disabled_admin_does_not_count(string method, string? patch)
    {
        var admin = await TestUsers.CreateAsync(_factory.Services, Roles.Admin);
        var client = await TestUsers.SignedInClientAsync(_factory, admin);
        var other = await TestUsers.CreateAsync(_factory.Services, Roles.Admin);
        Assert.Equal(HttpStatusCode.OK, (await SendAsync(client, "PATCH", $"{Users}/{other.Id}", """{"disabled":true}""")).StatusCode);

        var response = await SendAsync(client, method, $"{Users}/{admin.Id}", patch);

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
    }

    [Theory]
    [MemberData(nameof(Removals))]
    public async Task With_another_admin_the_change_goes_through(string method, string? patch)
    {
        var admin = await TestUsers.CreateAsync(_factory.Services, Roles.Admin);
        var client = await TestUsers.SignedInClientAsync(_factory, admin);
        var other = await TestUsers.CreateAsync(_factory.Services, Roles.Admin);

        var response = await SendAsync(client, method, $"{Users}/{other.Id}", patch);

        Assert.True(response.IsSuccessStatusCode, $"{method} answered {(int)response.StatusCode}");
    }

    private static async Task<HttpResponseMessage> SendAsync(ApiClient client, string method, string path, string? patch)
    {
        var etag = (await client.GetAsync(path)).Headers.ETag!.ToString();
        var body = patch is null ? null : (object)System.Text.Json.JsonDocument.Parse(patch).RootElement;
        return await client.SendAsync(new HttpMethod(method), path, body, ifMatch: etag);
    }
}
