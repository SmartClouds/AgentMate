using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;
using Npgsql;
using Runova.Website.Core.Identity;
using Runova.Website.Data;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.ApiClients;

public sealed class ApiClientAdminTests(PostgresFixture postgres) : IAsyncLifetime
{
    private const string Clients = "/api/v1/api-clients";

    private static readonly string[] _dtoProperties =
    [
        "id", "name", "scopes", "ipAllowlist", "keys", "expiresAt", "revokedAt", "lastUsedAt", "createdAt", "version",
    ];

    private readonly FakeTimeProvider _time = new(TestApiClients.Now);
    private string _connectionString = null!;
    private WebsiteApiFactory _factory = null!;

    public async ValueTask InitializeAsync()
    {
        _connectionString = await postgres.CreateDatabaseAsync();
        _factory = new(_connectionString, time: _time);
    }

    public ValueTask DisposeAsync()
    {
        _factory.Dispose();
        return ValueTask.CompletedTask;
    }

    [Fact]
    public async Task An_admin_creates_a_client_and_sees_its_secret_once()
    {
        var admin = await AdminAsync();

        var response = await admin.SendAsync(HttpMethod.Post, Clients, CreateBody("Advisory importer", ipAllowlist: ["203.0.113.0/24", "2001:db8::1"]));
        var created = await ApiClient.ReadJsonAsync(response, HttpStatusCode.Created);

        Assert.Equal(["client", "keyId", "secret"], created.EnumerateObject().Select(p => p.Name));
        var client = created.GetProperty("client");
        var id = client.GetProperty("id").GetInt64();
        var keyId = created.GetProperty("keyId").GetString()!;
        var secret = created.GetProperty("secret").GetString()!;
        Assert.Equal($"{Clients}/{id}", response.Headers.Location?.OriginalString);
        Assert.Matches("^rk_[0-9a-f]{16}$", keyId);
        Assert.Matches("^rnv_sk_[A-Za-z0-9_-]{43}$", secret);
        Assert.Equal(_dtoProperties, client.EnumerateObject().Select(p => p.Name));
        Assert.Equal("Advisory importer", client.GetProperty("name").GetString());
        Assert.Equal(["news:write"], client.GetProperty("scopes").EnumerateArray().Select(s => s.GetString()));
        Assert.Equal(["203.0.113.0/24", "2001:db8::1"], client.GetProperty("ipAllowlist").EnumerateArray().Select(s => s.GetString()));
        var key = Assert.Single(client.GetProperty("keys").EnumerateArray());
        Assert.Equal(keyId, key.GetProperty("keyId").GetString());
        Assert.Equal("2026-10-30T12:00:00.000Z", key.GetProperty("createdAt").GetString());
        Assert.Equal(JsonValueKind.Null, key.GetProperty("expiresAt").ValueKind);
        Assert.Equal(JsonValueKind.Null, client.GetProperty("lastUsedAt").ValueKind);
        Assert.Equal(JsonValueKind.Null, client.GetProperty("revokedAt").ValueKind);

        var read = await admin.GetAsync($"{Clients}/{id}");
        var body = await read.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.OK, read.StatusCode);
        Assert.Equal($"\"{client.GetProperty("version").GetString()}\"", read.Headers.ETag?.ToString());
        Assert.DoesNotContain(secret, body, StringComparison.Ordinal);
        Assert.DoesNotContain("secret", body, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(client.ToString(), JsonDocument.Parse(body).RootElement.ToString());

        var list = await admin.GetAsync(Clients);
        Assert.DoesNotContain(secret, await list.Content.ReadAsStringAsync(TestContext.Current.CancellationToken), StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_secret_is_stored_only_as_a_sealed_hash_and_never_in_the_audit_log()
    {
        var admin = await AdminAsync();
        var created = await ApiClient.ReadJsonAsync(await admin.SendAsync(HttpMethod.Post, Clients, CreateBody("Hash only")), HttpStatusCode.Created);
        var secret = created.GetProperty("secret").GetString()!;
        var id = created.GetProperty("client").GetProperty("id").GetInt64();
        var rotated = await ApiClient.ReadJsonAsync(
            await admin.SendAsync(HttpMethod.Post, $"{Clients}/{id}/secrets", new { overlapMinutes = 0 }), HttpStatusCode.Created);
        var secrets = new[] { secret, rotated.GetProperty("secret").GetString()! };

        // Every text column of every table, read raw, holds neither secret nor its hex hash.
        await using var connection = new NpgsqlConnection(_connectionString);
        await connection.OpenAsync(TestContext.Current.CancellationToken);
        var dump = new System.Text.StringBuilder();
        foreach (var table in new[] { "ApiClients", "ApiClientKeys", "AuditEntries" })
        {
            await using var command = new NpgsqlCommand($"SELECT row_to_json(t)::text FROM \"{table}\" t", connection);
            await using var reader = await command.ExecuteReaderAsync(TestContext.Current.CancellationToken);
            while (await reader.ReadAsync(TestContext.Current.CancellationToken))
            {
                dump.AppendLine(reader.GetString(0));
            }
        }

        foreach (var value in secrets)
        {
            Assert.DoesNotContain(value, dump.ToString(), StringComparison.Ordinal);
            Assert.DoesNotContain(value["rnv_sk_".Length..], dump.ToString(), StringComparison.Ordinal);
            Assert.DoesNotContain(Convert.ToHexStringLower(Core.Signing.RequestSignature.SigningKey(value)), dump.ToString(), StringComparison.Ordinal);
            Assert.DoesNotContain(Convert.ToBase64String(Core.Signing.RequestSignature.SigningKey(value)), dump.ToString(), StringComparison.Ordinal);
        }

        Assert.Contains("api-client.create", dump.ToString(), StringComparison.Ordinal);
        Assert.Contains("api-client.rotate", dump.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Only_an_admin_manages_clients()
    {
        var editor = await TestUsers.SignedInClientAsync(_factory, await TestUsers.CreateAsync(_factory.Services, Roles.Editor));

        var signedOut = await _factory.CreateApiClient().GetAsync(Clients);
        var asEditor = await editor.SendAsync(HttpMethod.Post, Clients, CreateBody("Not for editors"));

        await ProblemAssert.IsProblemAsync(signedOut, HttpStatusCode.Unauthorized, ProblemAssert.Type("unauthorized"), Clients);
        await ProblemAssert.IsProblemAsync(asEditor, HttpStatusCode.Forbidden, ProblemAssert.Type("forbidden"), Clients);
    }

    [Fact]
    public async Task A_signed_client_can_not_manage_clients()
    {
        var (keyId, secret) = await TestApiClients.AddAsync(_factory.Services, scopes: ["news:write", "posts:write"]);

        var response = await TestApiClients.Http(_factory, keyId, secret).GetAsync(Clients, TestContext.Current.CancellationToken);

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.Forbidden, ProblemAssert.Type("forbidden"), Clients);
    }

    [Fact]
    public async Task A_bad_create_names_every_field_at_fault()
    {
        var admin = await AdminAsync();
        var body = new JsonObject
        {
            ["name"] = "",
            ["scopes"] = new JsonArray("news:read"),
            ["ipAllowlist"] = new JsonArray("203.0.113.0/24", "not-an-ip", "10.0.0.0/33"),
            ["expiresAt"] = "2026-10-30T11:00:00.000Z",
        };

        var response = await admin.SendAsync(HttpMethod.Post, Clients, body);
        var problem = await ProblemAssert.IsProblemAsync(response, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), Clients);
        var errors = problem.GetProperty("errors").EnumerateObject().Select(p => p.Name).Order(StringComparer.Ordinal);

        Assert.Equal(["expiresAt", "ipAllowlist[1]", "ipAllowlist[2]", "name", "scopes[0]"], errors);
    }

    [Theory]
    [InlineData("""{"name":"No scopes","scopes":[],"ipAllowlist":[],"expiresAt":null}""", "scopes")]
    [InlineData("""{"name":"Typo","scopes":["news:write"],"ipAllowlist":[],"expiresAt":null,"scope":1}""", "scope")]
    public async Task A_create_with_no_scope_or_an_unknown_field_is_refused(string json, string field)
    {
        var admin = await AdminAsync();

        var response = await admin.SendAsync(HttpMethod.Post, Clients, JsonNode.Parse(json));
        var problem = await ProblemAssert.IsProblemAsync(response, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), Clients);

        Assert.True(problem.GetProperty("errors").TryGetProperty(field, out _), problem.ToString());
    }

    [Fact]
    public async Task A_name_is_taken_once()
    {
        var admin = await AdminAsync();
        await ApiClient.ReadJsonAsync(await admin.SendAsync(HttpMethod.Post, Clients, CreateBody("Only one")), HttpStatusCode.Created);

        var response = await admin.SendAsync(HttpMethod.Post, Clients, CreateBody("Only one"));

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.Conflict, ProblemAssert.Type("conflict"), Clients);
    }

    [Fact]
    public async Task An_admin_lists_clients_and_filters_by_revoked()
    {
        var admin = await AdminAsync();
        var (kept, _) = await CreateAsync(admin, "Kept");
        var (revoked, etag) = await CreateAsync(admin, "Revoked");
        Assert.Equal(HttpStatusCode.NoContent, (await admin.SendAsync(HttpMethod.Delete, $"{Clients}/{revoked}", ifMatch: etag)).StatusCode);

        var all = await ApiClient.ReadJsonAsync(await admin.GetAsync(Clients), HttpStatusCode.OK);
        var onlyRevoked = await ApiClient.ReadJsonAsync(await admin.GetAsync($"{Clients}?revoked=true"), HttpStatusCode.OK);
        var notRevoked = await ApiClient.ReadJsonAsync(await admin.GetAsync($"{Clients}?revoked=false&pageSize=1"), HttpStatusCode.OK);

        Assert.Equal(2, all.GetProperty("totalItems").GetInt32());
        Assert.Equal([kept, revoked], all.GetProperty("items").EnumerateArray().Select(c => c.GetProperty("id").GetInt64()));
        Assert.Equal(revoked, Assert.Single(onlyRevoked.GetProperty("items").EnumerateArray()).GetProperty("id").GetInt64());
        Assert.Equal(kept, Assert.Single(notRevoked.GetProperty("items").EnumerateArray()).GetProperty("id").GetInt64());
        Assert.Equal(1, notRevoked.GetProperty("pageSize").GetInt32());
    }

    [Fact]
    public async Task An_admin_patches_a_client_with_if_match()
    {
        var admin = await AdminAsync();
        var (id, etag) = await CreateAsync(admin, "Before the patch");
        var patch = new JsonObject
        {
            ["name"] = "After the patch",
            ["scopes"] = new JsonArray("news:write", "posts:write"),
            ["expiresAt"] = "2027-01-01T00:00:00.000Z",
        };

        var missing = await admin.SendAsync(HttpMethod.Patch, $"{Clients}/{id}", patch);
        var stale = await admin.SendAsync(HttpMethod.Patch, $"{Clients}/{id}", patch, ifMatch: "\"1\"");
        var response = await admin.SendAsync(HttpMethod.Patch, $"{Clients}/{id}", patch, ifMatch: etag);
        var client = await ApiClient.ReadJsonAsync(response, HttpStatusCode.OK);

        Assert.Equal(HttpStatusCode.PreconditionRequired, missing.StatusCode);
        Assert.Equal(HttpStatusCode.PreconditionFailed, stale.StatusCode);
        Assert.Equal("After the patch", client.GetProperty("name").GetString());
        Assert.Equal(["news:write", "posts:write"], client.GetProperty("scopes").EnumerateArray().Select(s => s.GetString()));
        Assert.Equal(0, client.GetProperty("ipAllowlist").GetArrayLength());
        Assert.Equal("2027-01-01T00:00:00.000Z", client.GetProperty("expiresAt").GetString());
        Assert.Equal($"\"{client.GetProperty("version").GetString()}\"", response.Headers.ETag?.ToString());
        Assert.NotEqual(etag, response.Headers.ETag?.ToString());

        var invalid = await admin.SendAsync(HttpMethod.Patch, $"{Clients}/{id}", new JsonObject { ["keys"] = new JsonArray() }, ifMatch: response.Headers.ETag!.ToString());
        await ProblemAssert.IsProblemAsync(invalid, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), $"{Clients}/{id}");
    }

    [Fact]
    public async Task Deleting_revokes_at_once_and_keeps_the_client()
    {
        var admin = await AdminAsync();
        var (id, etag) = await CreateAsync(admin, "To revoke");

        Assert.Equal(HttpStatusCode.PreconditionRequired, (await admin.SendAsync(HttpMethod.Delete, $"{Clients}/{id}")).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await admin.SendAsync(HttpMethod.Delete, $"{Clients}/{id}", ifMatch: etag)).StatusCode);

        var client = await ApiClient.ReadJsonAsync(await admin.GetAsync($"{Clients}/{id}"), HttpStatusCode.OK);
        Assert.Equal("2026-10-30T12:00:00.000Z", client.GetProperty("revokedAt").GetString());
        var rotate = await admin.SendAsync(HttpMethod.Post, $"{Clients}/{id}/secrets", new { });
        Assert.Equal(HttpStatusCode.NotFound, rotate.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await admin.GetAsync($"{Clients}/12345")).StatusCode);

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var actions = await db.AuditEntries.Where(e => e.TargetType == "api-client").OrderBy(e => e.Id).Select(e => e.Action)
            .ToListAsync(TestContext.Current.CancellationToken);
        Assert.Equal(["api-client.create", "api-client.revoke"], actions);
    }

    [Fact]
    public async Task Rotation_answers_the_new_secret_and_when_the_old_key_stops()
    {
        var admin = await AdminAsync();
        var (id, _) = await CreateAsync(admin, "Rotated");

        var response = await admin.SendAsync(HttpMethod.Post, $"{Clients}/{id}/secrets", new { overlapMinutes = 60 });
        var rotated = await ApiClient.ReadJsonAsync(response, HttpStatusCode.Created);
        var defaulted = await ApiClient.ReadJsonAsync(await admin.SendAsync(HttpMethod.Post, $"{Clients}/{id}/secrets", new { }), HttpStatusCode.Created);
        var tooLong = await admin.SendAsync(HttpMethod.Post, $"{Clients}/{id}/secrets", new { overlapMinutes = 10081 });

        Assert.Equal(["keyId", "secret", "previousKeyExpiresAt"], rotated.EnumerateObject().Select(p => p.Name));
        Assert.Matches("^rnv_sk_[A-Za-z0-9_-]{43}$", rotated.GetProperty("secret").GetString());
        Assert.Equal("2026-10-30T13:00:00.000Z", rotated.GetProperty("previousKeyExpiresAt").GetString());
        Assert.Equal("2026-10-31T12:00:00.000Z", defaulted.GetProperty("previousKeyExpiresAt").GetString());
        await ProblemAssert.IsProblemAsync(tooLong, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), $"{Clients}/{id}/secrets");

        // The first key keeps its earlier end; the second gets the default overlap; the newest has none.
        var client = await ApiClient.ReadJsonAsync(await admin.GetAsync($"{Clients}/{id}"), HttpStatusCode.OK);
        var ends = client.GetProperty("keys").EnumerateArray().Select(k => k.GetProperty("expiresAt").ToString()).ToList();
        Assert.Equal(["2026-10-30T13:00:00.000Z", "2026-10-31T12:00:00.000Z", ""], ends);
    }

    private async Task<ApiClient> AdminAsync() =>
        await TestUsers.SignedInClientAsync(_factory, await TestUsers.CreateAsync(_factory.Services, Roles.Admin));

    private static async Task<(long Id, string ETag)> CreateAsync(ApiClient admin, string name)
    {
        var response = await admin.SendAsync(HttpMethod.Post, Clients, CreateBody(name));
        var created = await ApiClient.ReadJsonAsync(response, HttpStatusCode.Created);
        var client = created.GetProperty("client");
        return (client.GetProperty("id").GetInt64(), $"\"{client.GetProperty("version").GetString()}\"");
    }

    private static JsonObject CreateBody(string name, string[]? scopes = null, string[]? ipAllowlist = null) => new()
    {
        ["name"] = name,
        ["scopes"] = new JsonArray([.. (scopes ?? ["news:write"]).Select(s => (JsonNode)s)]),
        ["ipAllowlist"] = new JsonArray([.. (ipAllowlist ?? []).Select(s => (JsonNode)s)]),
        ["expiresAt"] = null,
    };
}
