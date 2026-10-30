using System.Net;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Runova.Website.Core.Identity;
using Runova.Website.Data;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Users;

public sealed class AuditTests : IDisposable
{
    private const string Users = "/api/v1/users";

    private readonly WebsiteApiFactory _factory;

    public AuditTests(PostgresFixture postgres) => _factory = new(postgres.ConnectionString);

    public void Dispose() => _factory.Dispose();

    [Fact]
    public async Task Every_change_to_a_user_writes_an_audit_entry_with_no_secret()
    {
        var actor = await TestUsers.CreateAsync(_factory.Services, Roles.Admin);
        var admin = await TestUsers.SignedInClientAsync(_factory, actor);
        var invited = await ApiClient.ReadJsonAsync(
            await admin.SendAsync(HttpMethod.Post, Users, new { email = $"{Guid.NewGuid():N}@audit.runovahq.com", displayName = "Audited", roles = new[] { "Editor" } }),
            HttpStatusCode.Created);
        var id = invited.GetProperty("user").GetProperty("id").GetInt64();
        var path = $"{Users}/{id}";

        Assert.Equal(HttpStatusCode.Created, (await admin.SendAsync(HttpMethod.Post, path + "/invitations")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await admin.SendAsync(HttpMethod.Patch, path, new { displayName = "Renamed" }, ifMatch: await ETagAsync(admin, path))).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await admin.SendAsync(HttpMethod.Post, path + "/password-resets")).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await admin.SendAsync(HttpMethod.Delete, path + "/two-factor")).StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await admin.SendAsync(HttpMethod.Delete, path, ifMatch: await ETagAsync(admin, path))).StatusCode);

        using var scope = _factory.Services.CreateScope();
        var entries = await scope.ServiceProvider.GetRequiredService<AppDbContext>().AuditEntries.AsNoTracking()
            .Where(e => e.TargetType == "user" && e.TargetId == id.ToString(System.Globalization.CultureInfo.InvariantCulture))
            .OrderBy(e => e.Id)
            .ToListAsync(TestContext.Current.CancellationToken);
        Assert.Equal(
            ["user.invite", "user.invite", "user.update", "user.password-reset", "user.two-factor-reset", "user.delete"],
            entries.Select(e => e.Action));
        Assert.All(entries, entry =>
        {
            Assert.Equal("user", entry.ActorKind);
            Assert.Equal(actor.Id, entry.ActorId);
            Assert.InRange(entry.At, DateTimeOffset.UtcNow.AddMinutes(-5), DateTimeOffset.UtcNow.AddMinutes(1));
        });
        Assert.Contains("Renamed", entries[2].Changes, StringComparison.Ordinal);

        var token = invited.GetProperty("setupLink").GetProperty("url").GetString()!.Split("#token=")[1];
        var all = JsonSerializer.Serialize(entries);
        Assert.DoesNotContain(token, all, StringComparison.Ordinal);
        Assert.DoesNotContain("password", string.Join(" ", entries.Select(e => e.Changes)), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Setting_a_password_from_a_link_writes_an_entry_by_that_user()
    {
        var admin = await TestUsers.SignedInClientAsync(_factory, await TestUsers.CreateAsync(_factory.Services, Roles.Admin));
        var user = await TestUsers.CreateAsync(_factory.Services);
        var link = await ApiClient.ReadJsonAsync(await admin.SendAsync(HttpMethod.Post, $"{Users}/{user.Id}/password-resets"), HttpStatusCode.Created);
        var anonymous = _factory.CreateApiClient();
        await anonymous.RefreshAntiforgeryTokenAsync();

        var response = await anonymous.SendAsync(
            HttpMethod.Post, "/api/v1/password-setups", new { token = link.GetProperty("url").GetString()!.Split("#token=")[1], password = "a brand new passphrase" });

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        using var scope = _factory.Services.CreateScope();
        var last = await scope.ServiceProvider.GetRequiredService<AppDbContext>().AuditEntries.AsNoTracking()
            .Where(e => e.TargetType == "user" && e.TargetId == user.Id.ToString(System.Globalization.CultureInfo.InvariantCulture))
            .OrderBy(e => e.Id)
            .LastAsync(TestContext.Current.CancellationToken);
        Assert.Equal("user.update", last.Action);
        Assert.Equal(user.Id, last.ActorId);
    }

    [Fact]
    public async Task A_refused_change_writes_no_entry()
    {
        var admin = await TestUsers.SignedInClientAsync(_factory, await TestUsers.CreateAsync(_factory.Services, Roles.Admin));
        var user = await TestUsers.CreateAsync(_factory.Services);
        var path = $"{Users}/{user.Id}";

        Assert.Equal(HttpStatusCode.BadRequest, (await admin.SendAsync(HttpMethod.Patch, path, new { roles = new[] { "Owner" } }, ifMatch: await ETagAsync(admin, path))).StatusCode);
        Assert.Equal(HttpStatusCode.PreconditionFailed, (await admin.SendAsync(HttpMethod.Patch, path, new { displayName = "x" }, ifMatch: "\"1\"")).StatusCode);

        using var scope = _factory.Services.CreateScope();
        Assert.False(await scope.ServiceProvider.GetRequiredService<AppDbContext>().AuditEntries
            .AnyAsync(e => e.TargetType == "user" && e.TargetId == user.Id.ToString(System.Globalization.CultureInfo.InvariantCulture), TestContext.Current.CancellationToken));
    }

    private static async Task<string> ETagAsync(ApiClient admin, string path) => (await admin.GetAsync(path)).Headers.ETag!.ToString();
}
