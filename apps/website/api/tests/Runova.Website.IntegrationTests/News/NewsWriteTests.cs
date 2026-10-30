using System.Globalization;
using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;
using Runova.Website.Core.Identity;
using Runova.Website.Data;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.News;

public sealed class NewsWriteTests(PostgresFixture postgres) : IAsyncLifetime
{
    private const string News = "/api/v1/news";

    // The properties of the contract's NewsItemAdminDto, in order, and nothing else.
    private static readonly string[] _adminProperties =
    [
        "id", "slug", "url", "title", "summary", "category", "severity", "technologies", "cveIds", "cvssScore",
        "tags", "publishedAt", "updatedAt", "bodyHtml", "sourceLinks", "bodyMarkdown", "status", "createdAt",
        "createdBy", "version",
    ];

    private static readonly DateTimeOffset _now = new(2026, 10, 30, 12, 0, 0, TimeSpan.Zero);

    private readonly FakeTimeProvider _time = new(_now);
    private WebsiteApiFactory _factory = null!;

    public async ValueTask InitializeAsync() => _factory = new(await postgres.CreateDatabaseAsync(), time: _time);

    public ValueTask DisposeAsync()
    {
        _factory.Dispose();
        return ValueTask.CompletedTask;
    }

    [Fact]
    public async Task An_editor_creates_an_item_and_gets_it_back_with_its_location_and_etag()
    {
        var user = await TestUsers.CreateAsync(_factory.Services, Roles.Editor, displayName: "Sam Editor");
        var editor = await TestUsers.SignedInClientAsync(_factory, user);

        var response = await editor.SendAsync(HttpMethod.Post, News, Body("openssh-10-3-fixes-a-pre-auth-crash"));
        var created = await ApiClient.ReadJsonAsync(response, HttpStatusCode.Created);

        var id = created.GetProperty("id").GetInt64();
        Assert.Equal($"/api/v1/news/{id}", response.Headers.Location?.OriginalString);
        Assert.Equal($"\"{created.GetProperty("version").GetString()}\"", response.Headers.ETag?.ToString());
        Assert.Equal("private, no-store", CacheControl(response));
        Assert.Equal(_adminProperties, created.EnumerateObject().Select(p => p.Name));
        Assert.Equal("openssh-10-3-fixes-a-pre-auth-crash", created.GetProperty("slug").GetString());
        Assert.Equal("security", created.GetProperty("category").GetString());
        Assert.Equal("high", created.GetProperty("severity").GetString());
        Assert.Equal("published", created.GetProperty("status").GetString());
        Assert.Equal("2026-10-30T12:00:00.000Z", created.GetProperty("publishedAt").GetString());
        Assert.Equal("2026-10-30T12:00:00.000Z", created.GetProperty("createdAt").GetString());
        Assert.Equal("2026-10-30T12:00:00.000Z", created.GetProperty("updatedAt").GetString());
        Assert.Equal("OpenSSH", created.GetProperty("technologies")[0].GetProperty("name").GetString());
        Assert.Contains("<h2", created.GetProperty("bodyHtml").GetString(), StringComparison.Ordinal);
        Assert.Equal("## What happened\nA crafted key exchange.", created.GetProperty("bodyMarkdown").GetString());
        var createdBy = created.GetProperty("createdBy");
        Assert.Equal("user", createdBy.GetProperty("kind").GetString());
        Assert.Equal(user.Id, createdBy.GetProperty("id").GetInt64());
        Assert.Equal("Sam Editor", createdBy.GetProperty("name").GetString());

        var read = await editor.GetAsync($"{News}/{id}");
        var item = await ApiClient.ReadJsonAsync(read, HttpStatusCode.OK);
        Assert.Equal(response.Headers.ETag, read.Headers.ETag);
        Assert.Equal("private, no-store", CacheControl(read));
        Assert.Equal(created.ToString(), item.ToString());

        var published = await ApiClient.ReadJsonAsync(await editor.GetAsync($"{News}/openssh-10-3-fixes-a-pre-auth-crash"), HttpStatusCode.OK);
        Assert.Equal(id, published.GetProperty("id").GetInt64());
    }

    [Fact]
    public async Task An_admin_may_write_news_too()
    {
        var admin = await TestUsers.SignedInClientAsync(_factory, await TestUsers.CreateAsync(_factory.Services, Roles.Admin));

        var response = await admin.SendAsync(HttpMethod.Post, News, Body("written-by-an-admin"));

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
    }

    [Fact]
    public async Task An_editor_replaces_an_item_with_put()
    {
        var editor = await EditorAsync();
        var (id, etag) = await CreateAsync(editor, Body("before-the-put"));
        _time.Advance(TimeSpan.FromMinutes(10));

        var body = Body("after-the-put", category: "release", severity: "info", technologies: [], title: "Node.js 24.3 is out");
        var response = await editor.SendAsync(HttpMethod.Put, $"{News}/{id}", body, ifMatch: etag);
        var item = await ApiClient.ReadJsonAsync(response, HttpStatusCode.OK);

        Assert.Equal("after-the-put", item.GetProperty("slug").GetString());
        Assert.Equal("Node.js 24.3 is out", item.GetProperty("title").GetString());
        Assert.Equal("release", item.GetProperty("category").GetString());
        Assert.Equal(0, item.GetProperty("technologies").GetArrayLength());
        Assert.Equal("2026-10-30T12:10:00.000Z", item.GetProperty("updatedAt").GetString());
        Assert.Equal("2026-10-30T12:00:00.000Z", item.GetProperty("createdAt").GetString());
        Assert.NotEqual(etag, response.Headers.ETag?.ToString());
        Assert.Equal($"\"{item.GetProperty("version").GetString()}\"", response.Headers.ETag?.ToString());
    }

    [Fact]
    public async Task An_editor_changes_some_fields_with_a_merge_patch()
    {
        var editor = await EditorAsync();
        var (id, etag) = await CreateAsync(editor, Body("patched-item"));

        var patch = new JsonObject
        {
            ["title"] = "A better title for it",
            ["bodyMarkdown"] = "Just *one* line now.",
            ["cvssScore"] = null,
            ["tags"] = new JsonArray("ssh"),
        };
        var response = await editor.SendAsync(HttpMethod.Patch, $"{News}/{id}", patch, ifMatch: etag);
        var item = await ApiClient.ReadJsonAsync(response, HttpStatusCode.OK);

        Assert.Equal("A better title for it", item.GetProperty("title").GetString());
        Assert.Equal("<p>Just <em>one</em> line now.</p>", item.GetProperty("bodyHtml").GetString()?.Trim());
        Assert.Equal(JsonValueKind.Null, item.GetProperty("cvssScore").ValueKind);
        Assert.Equal(["ssh"], item.GetProperty("tags").EnumerateArray().Select(t => t.GetString()));
        Assert.Equal("patched-item", item.GetProperty("slug").GetString());
        Assert.Equal("high", item.GetProperty("severity").GetString());
        Assert.Equal("openssh", item.GetProperty("technologies")[0].GetProperty("technology").GetString());
    }

    [Fact]
    public async Task Delete_archives_the_item_so_it_is_no_longer_public()
    {
        var editor = await EditorAsync();
        var (id, etag) = await CreateAsync(editor, Body("to-be-archived"));

        var response = await editor.SendAsync(HttpMethod.Delete, $"{News}/{id}", ifMatch: etag);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        var item = await ApiClient.ReadJsonAsync(await editor.GetAsync($"{News}/{id}"), HttpStatusCode.OK);
        Assert.Equal("archived", item.GetProperty("status").GetString());
        await ProblemAssert.IsProblemAsync(
            await editor.GetAsync($"{News}/to-be-archived"), HttpStatusCode.NotFound, ProblemAssert.Type("not-found"), $"{News}/to-be-archived");
        var list = await ApiClient.ReadJsonAsync(await editor.GetAsync(News), HttpStatusCode.OK);
        Assert.Equal(0, list.GetProperty("totalItems").GetInt32());
    }

    [Theory]
    [InlineData("GET", "/1")]
    [InlineData("POST", "")]
    [InlineData("PUT", "/1")]
    [InlineData("PATCH", "/1")]
    [InlineData("DELETE", "/1")]
    public async Task A_signed_out_caller_gets_401(string method, string path)
    {
        var anonymous = _factory.CreateApiClient();

        var response = await anonymous.SendAsync(new HttpMethod(method), News + path, method is "POST" or "PUT" or "PATCH" ? Body("signed-out") : null, ifMatch: "\"1\"");

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.Unauthorized, ProblemAssert.Type("unauthorized"), News + path);
    }

    [Theory]
    [InlineData("GET")]
    [InlineData("PUT")]
    [InlineData("PATCH")]
    [InlineData("DELETE")]
    public async Task An_unknown_id_gets_404(string method)
    {
        var editor = await EditorAsync();

        var response = await editor.SendAsync(new HttpMethod(method), $"{News}/987654", method is "PUT" or "PATCH" ? Body("no-such-item") : null, ifMatch: "\"1\"");

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.NotFound, ProblemAssert.Type("not-found"), $"{News}/987654");
    }

    [Theory]
    [InlineData("PUT")]
    [InlineData("PATCH")]
    [InlineData("DELETE")]
    public async Task A_stale_if_match_gets_412_with_the_current_version(string method)
    {
        var editor = await EditorAsync();
        var (id, etag) = await CreateAsync(editor, Body("changed-meanwhile"));
        var changed = await editor.SendAsync(HttpMethod.Patch, $"{News}/{id}", new { title = "Changed by someone else" }, ifMatch: etag);
        Assert.Equal(HttpStatusCode.OK, changed.StatusCode);

        var response = await editor.SendAsync(new HttpMethod(method), $"{News}/{id}", WriteBody(method, "changed-meanwhile"), ifMatch: etag);

        var problem = await ProblemAssert.IsProblemAsync(response, HttpStatusCode.PreconditionFailed, ProblemAssert.Type("precondition-failed"), $"{News}/{id}");
        Assert.Equal(changed.Headers.ETag?.ToString(), $"\"{problem.GetProperty("currentVersion").GetString()}\"");
    }

    [Theory]
    [InlineData("PUT")]
    [InlineData("PATCH")]
    [InlineData("DELETE")]
    public async Task A_missing_if_match_gets_428(string method)
    {
        var editor = await EditorAsync();
        var (id, _) = await CreateAsync(editor, Body("no-if-match"));

        var response = await editor.SendAsync(new HttpMethod(method), $"{News}/{id}", WriteBody(method, "no-if-match"));

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.PreconditionRequired, ProblemAssert.Type("precondition-required"), $"{News}/{id}");
    }

    [Fact]
    public async Task A_duplicate_slug_gets_409_even_when_the_other_item_is_archived()
    {
        var editor = await EditorAsync();
        var (id, etag) = await CreateAsync(editor, Body("taken-slug"));
        Assert.Equal(HttpStatusCode.NoContent, (await editor.SendAsync(HttpMethod.Delete, $"{News}/{id}", ifMatch: etag)).StatusCode);

        var response = await editor.SendAsync(HttpMethod.Post, News, Body("taken-slug"));

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.Conflict, ProblemAssert.Type("conflict"), News);
    }

    [Theory]
    [InlineData("PUT")]
    [InlineData("PATCH")]
    public async Task Renaming_an_item_to_a_taken_slug_gets_409(string method)
    {
        var editor = await EditorAsync();
        await CreateAsync(editor, Body("first-slug"));
        var (id, etag) = await CreateAsync(editor, Body("second-slug"));

        var body = method == "PUT" ? Body("first-slug") : new JsonObject { ["slug"] = "first-slug" };
        var response = await editor.SendAsync(new HttpMethod(method), $"{News}/{id}", body, ifMatch: etag);

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.Conflict, ProblemAssert.Type("conflict"), $"{News}/{id}");
    }

    [Fact]
    public async Task An_unknown_technology_slug_gets_400_naming_the_field()
    {
        var editor = await EditorAsync();
        var body = Body("unknown-technology");
        body["technologies"] = new JsonArray(
            new JsonObject { ["technology"] = "openssh", ["versionRange"] = "*", ["fixedIn"] = null },
            new JsonObject { ["technology"] = "node", ["versionRange"] = "*", ["fixedIn"] = null });

        var response = await editor.SendAsync(HttpMethod.Post, News, body);

        var errors = await ValidationErrorsAsync(response, News);
        Assert.Equal(["technologies[1].technology"], errors.Keys);
        Assert.Equal(["Unknown technology slug 'node'."], errors["technologies[1].technology"]);
    }

    public static TheoryData<string, string, string> InvalidFields => new()
    {
        { "slug", "\"Not A Slug\"", "slug" },
        { "slug", "\"ab\"", "slug" },
        { "slug", "\"double--hyphen\"", "slug" },
        { "slug", "\"12345\"", "slug" },
        { "slug", "null", "slug" },
        { "title", "\"Shrt\"", "title" },
        { "title", $"\"{new string('t', 161)}\"", "title" },
        { "summary", "\"Too short a summary\"", "summary" },
        { "bodyMarkdown", $"\"{new string('b', 100_001)}\"", "bodyMarkdown" },
        { "category", "null", "category" },
        { "category", "\"gossip\"", "category" },
        { "severity", "\"info\"", "severity" },
        { "severity", "\"severe\"", "severity" },
        { "technologies", "[]", "technologies" },
        { "technologies", "[{\"technology\":\"openssh\",\"versionRange\":\"~1.2\",\"fixedIn\":null}]", "technologies[0].versionRange" },
        { "technologies", "[{\"technology\":\"openssh\",\"versionRange\":\"<10.3.0\",\"fixedIn\":\"10.2.0\"}]", "technologies[0].fixedIn" },
        { "technologies", "[{\"technology\":\"openssh\",\"versionRange\":\"*\",\"fixedIn\":null,\"extra\":1}]", "technologies[0].extra" },
        { "technologies", "[" + string.Join(",", Enumerable.Repeat("{\"technology\":\"git\",\"versionRange\":\"*\",\"fixedIn\":null}", 21)) + "]", "technologies" },
        { "cveIds", "[\"CVE-2026-1\"]", "cveIds[0]" },
        { "cveIds", "[\"CVE-2026-41234\",\"cve-2026-41235\"]", "cveIds[1]" },
        { "cvssScore", "10.5", "cvssScore" },
        { "cvssScore", "7.55", "cvssScore" },
        { "cvssScore", "-1", "cvssScore" },
        { "sourceLinks", "[{\"title\":\"Notes\",\"url\":\"http://example.com/notes\"}]", "sourceLinks[0].url" },
        { "sourceLinks", "[{\"title\":\"Notes\",\"url\":\"/relative\"}]", "sourceLinks[0].url" },
        { "sourceLinks", "[{\"title\":\"\",\"url\":\"https://example.com/notes\"}]", "sourceLinks[0].title" },
        { "sourceLinks", "[" + string.Join(",", Enumerable.Repeat("{\"title\":\"Notes\",\"url\":\"https://example.com\"}", 11)) + "]", "sourceLinks" },
        { "tags", "[\"x\"]", "tags[0]" },
        { "tags", "[\"ok\",\"Not-Lower\"]", "tags[1]" },
        { "tags", "[\"" + string.Join("\",\"", Enumerable.Range(10, 11)) + "\"]", "tags" },
        { "status", "\"archived\"", "status" },
        { "status", "\"scheduled\"", "publishedAt" },
        { "publishedAt", "\"2026-10-30T13:00:00.000Z\"", "publishedAt" },
        { "unknownField", "1", "unknownField" },
    };

    [Theory]
    [MemberData(nameof(InvalidFields))]
    public async Task A_field_out_of_its_rules_gets_400_naming_it(string field, string json, string key)
    {
        var editor = await EditorAsync();
        var body = Body("an-invalid-item");
        body[field] = JsonNode.Parse(json);

        var response = await editor.SendAsync(HttpMethod.Post, News, body);

        var errors = await ValidationErrorsAsync(response, News);
        Assert.Contains(key, errors.Keys);
    }

    [Fact]
    public async Task An_information_category_takes_info_and_nothing_higher()
    {
        var editor = await EditorAsync();

        var info = await editor.SendAsync(HttpMethod.Post, News, Body("release-at-info", category: "release", severity: "info"));
        var low = await editor.SendAsync(HttpMethod.Post, News, Body("release-at-low", category: "release", severity: "low"));

        Assert.Equal(HttpStatusCode.Created, info.StatusCode);
        Assert.Equal(["severity"], (await ValidationErrorsAsync(low, News)).Keys);
    }

    [Fact]
    public async Task A_patch_is_validated_as_the_item_it_makes()
    {
        var editor = await EditorAsync();
        var (id, etag) = await CreateAsync(editor, Body("patched-to-invalid"));

        var response = await editor.SendAsync(HttpMethod.Patch, $"{News}/{id}", new JsonObject { ["severity"] = "info", ["oops"] = 1 }, ifMatch: etag);

        var errors = await ValidationErrorsAsync(response, $"{News}/{id}");
        Assert.Contains("oops", errors.Keys);
    }

    [Fact]
    public async Task A_patch_that_breaks_a_rule_gets_400_naming_the_field()
    {
        var editor = await EditorAsync();
        var (id, etag) = await CreateAsync(editor, Body("patched-to-info"));

        var response = await editor.SendAsync(HttpMethod.Patch, $"{News}/{id}", new JsonObject { ["severity"] = "info" }, ifMatch: etag);

        Assert.Equal(["severity"], (await ValidationErrorsAsync(response, $"{News}/{id}")).Keys);
    }

    [Fact]
    public async Task A_body_that_is_not_json_gets_400()
    {
        var editor = await EditorAsync();
        var token = await editor.RefreshAntiforgeryTokenAsync();
        using var request = new HttpRequestMessage(HttpMethod.Post, News) { Content = new StringContent("{ not json", System.Text.Encoding.UTF8, "application/json") };
        request.Headers.Add(ApiClient.AntiforgeryHeader, token);

        var response = await editor.Http.SendAsync(request, TestContext.Current.CancellationToken);

        Assert.NotEmpty(await ValidationErrorsAsync(response, News));
    }

    [Fact]
    public async Task Every_write_leaves_an_audit_entry_with_the_user_id()
    {
        var user = await TestUsers.CreateAsync(_factory.Services, Roles.Editor);
        var editor = await TestUsers.SignedInClientAsync(_factory, user);
        var (id, etag) = await CreateAsync(editor, Body("audited-item"));
        var put = await editor.SendAsync(HttpMethod.Put, $"{News}/{id}", Body("audited-item", title: "Audited by a put"), ifMatch: etag);
        Assert.Equal(HttpStatusCode.OK, put.StatusCode);
        var patch = await editor.SendAsync(HttpMethod.Patch, $"{News}/{id}", new { title = "Audited by a patch" }, ifMatch: put.Headers.ETag?.ToString());
        Assert.Equal(HttpStatusCode.OK, patch.StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, (await editor.SendAsync(HttpMethod.Delete, $"{News}/{id}", ifMatch: patch.Headers.ETag?.ToString())).StatusCode);

        using var scope = _factory.Services.CreateScope();
        var entries = await scope.ServiceProvider.GetRequiredService<AppDbContext>().AuditEntries.AsNoTracking()
            .Where(e => e.TargetType == "news" && e.TargetId == id.ToString(CultureInfo.InvariantCulture))
            .OrderBy(e => e.Id)
            .ToListAsync(TestContext.Current.CancellationToken);
        Assert.Equal(["news.create", "news.update", "news.update", "news.archive"], entries.Select(e => e.Action));
        Assert.All(entries, entry =>
        {
            Assert.Equal("user", entry.ActorKind);
            Assert.Equal(user.Id, entry.ActorId);
            Assert.Equal(_now, entry.At);
        });
        Assert.Contains("title", entries[2].Changes, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_write_that_fails_leaves_no_audit_entry()
    {
        var editor = await EditorAsync();
        await CreateAsync(editor, Body("only-once"));

        Assert.Equal(HttpStatusCode.Conflict, (await editor.SendAsync(HttpMethod.Post, News, Body("only-once"))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await editor.SendAsync(HttpMethod.Post, News, Body("never-made", severity: "info"))).StatusCode);

        using var scope = _factory.Services.CreateScope();
        var actions = await scope.ServiceProvider.GetRequiredService<AppDbContext>().AuditEntries.AsNoTracking()
            .Where(e => e.TargetType == "news")
            .Select(e => e.Action)
            .ToListAsync(TestContext.Current.CancellationToken);
        Assert.Equal(["news.create"], actions);
    }

    /// <summary>A valid security item, published now unless the test changes it.</summary>
    internal static JsonObject Body(
        string slug,
        string category = "security",
        string severity = "high",
        string[]? technologies = null,
        string title = "OpenSSH 10.3 fixes a pre-auth crash",
        string status = "published",
        DateTimeOffset? publishedAt = null) => new()
        {
            ["slug"] = slug,
            ["title"] = title,
            ["summary"] = "A crafted key exchange can crash sshd before sign-in. Update to 10.3.",
            ["bodyMarkdown"] = "## What happened\nA crafted key exchange.",
            ["category"] = category,
            ["severity"] = severity,
            ["technologies"] = new JsonArray([.. (technologies ?? ["openssh"]).Select(t => (JsonNode)new JsonObject
            {
                ["technology"] = t,
                ["versionRange"] = ">=9.8.0 <10.3.0",
                ["fixedIn"] = "10.3.0",
            })]),
            ["cveIds"] = new JsonArray("CVE-2026-41234"),
            ["cvssScore"] = 7.5m,
            ["sourceLinks"] = new JsonArray(new JsonObject { ["title"] = "Release notes", ["url"] = "https://www.openssh.com/txt/release-10.3" }),
            ["tags"] = new JsonArray("ssh", "servers"),
            ["status"] = status,
            ["publishedAt"] = publishedAt?.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture),
        };

    /// <summary>Creates the item and returns its id and ETag.</summary>
    internal static async Task<(long Id, string ETag)> CreateAsync(ApiClient client, JsonObject body)
    {
        var response = await client.SendAsync(HttpMethod.Post, News, body);
        var created = await ApiClient.ReadJsonAsync(response, HttpStatusCode.Created);
        return (created.GetProperty("id").GetInt64(), response.Headers.ETag!.ToString());
    }

    private static JsonObject? WriteBody(string method, string slug) => method switch
    {
        "PUT" => Body(slug),
        "PATCH" => new JsonObject { ["title"] = "A title from a patch" },
        _ => null,
    };

    private static string CacheControl(HttpResponseMessage response) =>
        response.Headers.NonValidated["Cache-Control"].ToString();

    private async Task<ApiClient> EditorAsync() =>
        await TestUsers.SignedInClientAsync(_factory, await TestUsers.CreateAsync(_factory.Services, Roles.Editor));

    private static async Task<Dictionary<string, string[]>> ValidationErrorsAsync(HttpResponseMessage response, string instance)
    {
        var problem = await ProblemAssert.IsProblemAsync(response, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), instance);
        return problem.GetProperty("errors").EnumerateObject()
            .ToDictionary(p => p.Name, p => p.Value.EnumerateArray().Select(m => m.GetString()!).ToArray());
    }
}
