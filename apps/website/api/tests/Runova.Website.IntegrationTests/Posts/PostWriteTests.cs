using System.Globalization;
using System.Net;
using System.Text.Json.Nodes;
using AngleSharp.Html.Parser;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;
using Runova.Website.Api.News;
using Runova.Website.Core.Identity;
using Runova.Website.Data;
using Runova.Website.IntegrationTests.Infrastructure;
using ApiScopes = Runova.Website.Core.ApiClients.ApiScopes;

namespace Runova.Website.IntegrationTests.Posts;

public sealed class PostWriteTests(PostgresFixture postgres) : IAsyncLifetime
{
    private const string Posts = "/api/v1/posts";

    // The properties of the contract's PostAdminDto, in order, and nothing else.
    private static readonly string[] _adminProperties =
    [
        "id", "slug", "url", "title", "excerpt", "coverImage", "tags", "author", "publishedAt", "updatedAt", "readingTimeMinutes",
        "bodyHtml", "bodyMarkdown", "status", "createdAt", "createdBy", "version",
    ];

    private static readonly string[] _forbiddenElements = ["script", "iframe", "object", "embed", "form", "style"];

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
    public async Task An_editor_creates_a_post_and_gets_it_back_with_its_location_and_etag()
    {
        var user = await TestUsers.CreateAsync(_factory.Services, Roles.Editor, displayName: "Sam Editor");
        var editor = await TestUsers.SignedInClientAsync(_factory, user);

        var response = await editor.SendAsync(HttpMethod.Post, Posts, Body("hello-blog", tags: ["Docker", "AI Agents"]));
        var created = await ApiClient.ReadJsonAsync(response, HttpStatusCode.Created);

        var id = created.GetProperty("id").GetInt64();
        Assert.Equal($"/api/v1/posts/{id}", response.Headers.Location?.OriginalString);
        Assert.Equal($"\"{created.GetProperty("version").GetString()}\"", response.Headers.ETag?.ToString());
        Assert.Equal(_adminProperties, created.EnumerateObject().Select(p => p.Name));
        Assert.Equal("published", created.GetProperty("status").GetString());
        Assert.Equal("2026-10-30T12:00:00.000Z", created.GetProperty("publishedAt").GetString());
        Assert.Equal("Sam Editor", created.GetProperty("author").GetProperty("displayName").GetString());
        Assert.Equal("user", created.GetProperty("createdBy").GetProperty("kind").GetString());
        Assert.Equal(["ai-agents", "docker"], created.GetProperty("tags").EnumerateArray().Select(t => t.GetProperty("slug").GetString()).Order());
        Assert.Equal(1, created.GetProperty("readingTimeMinutes").GetInt32());
        Assert.Contains("<h2", created.GetProperty("bodyHtml").GetString(), StringComparison.Ordinal);

        var read = await ApiClient.ReadJsonAsync(await editor.GetAsync($"{Posts}/{id}"), HttpStatusCode.OK);
        Assert.Equal(created.ToString(), read.ToString());
        var published = await ApiClient.ReadJsonAsync(await editor.GetAsync($"{Posts}/hello-blog"), HttpStatusCode.OK);
        Assert.Equal(id, published.GetProperty("id").GetInt64());
    }

    [Fact]
    public async Task Put_replaces_patch_merges_and_delete_archives()
    {
        var editor = await EditorAsync();
        var (id, etag) = await CreateAsync(editor, Body("before-the-put", tags: ["Docker"]));
        _time.Advance(TimeSpan.FromMinutes(10));

        var put = await editor.SendAsync(HttpMethod.Put, $"{Posts}/{id}", Body("after-the-put", title: "A title from the put", tags: ["docker", "Rust"]), ifMatch: etag);
        var replaced = await ApiClient.ReadJsonAsync(put, HttpStatusCode.OK);
        Assert.Equal("after-the-put", replaced.GetProperty("slug").GetString());
        Assert.Equal("2026-10-30T12:10:00.000Z", replaced.GetProperty("updatedAt").GetString());
        Assert.Equal(["Docker", "Rust"], replaced.GetProperty("tags").EnumerateArray().Select(t => t.GetProperty("name").GetString()).Order());

        var patch = await editor.SendAsync(HttpMethod.Patch, $"{Posts}/{id}", new JsonObject { ["bodyMarkdown"] = "Just *one* line now." }, ifMatch: put.Headers.ETag!.ToString());
        var patched = await ApiClient.ReadJsonAsync(patch, HttpStatusCode.OK);
        Assert.Equal("<p>Just <em>one</em> line now.</p>", patched.GetProperty("bodyHtml").GetString()?.Trim());
        Assert.Equal("A title from the put", patched.GetProperty("title").GetString());

        var delete = await editor.SendAsync(HttpMethod.Delete, $"{Posts}/{id}", ifMatch: patch.Headers.ETag!.ToString());
        Assert.Equal(HttpStatusCode.NoContent, delete.StatusCode);
        var archived = await ApiClient.ReadJsonAsync(await editor.GetAsync($"{Posts}/{id}"), HttpStatusCode.OK);
        Assert.Equal("archived", archived.GetProperty("status").GetString());
        Assert.Equal(HttpStatusCode.NotFound, (await editor.GetAsync($"{Posts}/after-the-put")).StatusCode);
    }

    [Fact]
    public async Task A_duplicate_slug_gets_409_even_when_the_other_post_is_archived()
    {
        var editor = await EditorAsync();
        var (id, etag) = await CreateAsync(editor, Body("taken-slug"));
        Assert.Equal(HttpStatusCode.NoContent, (await editor.SendAsync(HttpMethod.Delete, $"{Posts}/{id}", ifMatch: etag)).StatusCode);
        var (otherId, otherEtag) = await CreateAsync(editor, Body("other-slug"));

        var create = await editor.SendAsync(HttpMethod.Post, Posts, Body("taken-slug"));
        var rename = await editor.SendAsync(HttpMethod.Patch, $"{Posts}/{otherId}", new JsonObject { ["slug"] = "taken-slug" }, ifMatch: otherEtag);

        await ProblemAssert.IsProblemAsync(create, HttpStatusCode.Conflict, ProblemAssert.Type("conflict"), Posts);
        await ProblemAssert.IsProblemAsync(rename, HttpStatusCode.Conflict, ProblemAssert.Type("conflict"), $"{Posts}/{otherId}");
    }

    [Theory]
    [InlineData("PUT")]
    [InlineData("PATCH")]
    [InlineData("DELETE")]
    public async Task A_stale_if_match_gets_412_and_a_missing_one_428(string method)
    {
        var editor = await EditorAsync();
        var (id, etag) = await CreateAsync(editor, Body("changed-meanwhile"));
        var changed = await editor.SendAsync(HttpMethod.Patch, $"{Posts}/{id}", new { title = "Changed by someone else" }, ifMatch: etag);
        Assert.Equal(HttpStatusCode.OK, changed.StatusCode);

        var stale = await editor.SendAsync(new HttpMethod(method), $"{Posts}/{id}", WriteBody(method), ifMatch: etag);
        var missing = await editor.SendAsync(new HttpMethod(method), $"{Posts}/{id}", WriteBody(method));

        var problem = await ProblemAssert.IsProblemAsync(stale, HttpStatusCode.PreconditionFailed, ProblemAssert.Type("precondition-failed"), $"{Posts}/{id}");
        Assert.Equal(changed.Headers.ETag?.ToString(), $"\"{problem.GetProperty("currentVersion").GetString()}\"");
        await ProblemAssert.IsProblemAsync(missing, HttpStatusCode.PreconditionRequired, ProblemAssert.Type("precondition-required"), $"{Posts}/{id}");
    }

    [Theory]
    [InlineData("GET", "/1")]
    [InlineData("POST", "")]
    [InlineData("PUT", "/1")]
    [InlineData("PATCH", "/1")]
    [InlineData("DELETE", "/1")]
    public async Task A_client_with_only_news_write_gets_403_on_post_writes(string method, string path)
    {
        var (keyId, secret) = await TestApiClients.AddAsync(_factory.Services, scopes: [ApiScopes.NewsWrite]);
        using var request = new HttpRequestMessage(new HttpMethod(method), Posts + path);
        if (method is "POST" or "PUT" or "PATCH")
        {
            request.Content = SignedContent.Json(Body("no-scope").ToJsonString());
        }

        request.Headers.TryAddWithoutValidation("If-Match", "\"1\"");
        var response = await TestApiClients.Http(_factory, keyId, secret).SendAsync(request, TestContext.Current.CancellationToken);

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.Forbidden, ProblemAssert.Type("forbidden"), Posts + path);
    }

    [Fact]
    public async Task A_client_with_posts_write_creates_a_post_under_its_own_name()
    {
        var (keyId, secret) = await TestApiClients.AddAsync(_factory.Services, scopes: [ApiScopes.PostsWrite], name: "Release notes bot");

        var response = await TestApiClients.Http(_factory, keyId, secret)
            .PostAsync(Posts, SignedContent.Json(Body("from-a-client").ToJsonString()), TestContext.Current.CancellationToken);

        var post = await ApiClient.ReadJsonAsync(response, HttpStatusCode.Created);
        Assert.Equal("Release notes bot", post.GetProperty("author").GetProperty("displayName").GetString());
        Assert.Equal("api-client", post.GetProperty("createdBy").GetProperty("kind").GetString());
    }

    [Fact]
    public async Task A_scheduled_post_goes_out_when_the_publish_job_runs_at_its_time()
    {
        var editor = await EditorAsync();
        var (id, _) = await CreateAsync(editor, Body("scheduled-post", status: "scheduled", publishedAt: _now.AddMinutes(30)));

        await RunPublishJobAsync();
        Assert.Equal(0, (await ApiClient.ReadJsonAsync(await editor.GetAsync(Posts), HttpStatusCode.OK)).GetProperty("totalItems").GetInt32());

        _time.Advance(TimeSpan.FromMinutes(30));
        await RunPublishJobAsync();

        var post = await ApiClient.ReadJsonAsync(await editor.GetAsync($"{Posts}/{id}"), HttpStatusCode.OK);
        Assert.Equal("published", post.GetProperty("status").GetString());
        Assert.Equal("2026-10-30T12:30:00.000Z", post.GetProperty("publishedAt").GetString());
        Assert.Equal(1, (await ApiClient.ReadJsonAsync(await editor.GetAsync(Posts), HttpStatusCode.OK)).GetProperty("totalItems").GetInt32());

        using var scope = _factory.Services.CreateScope();
        var actions = await scope.ServiceProvider.GetRequiredService<AppDbContext>().AuditEntries.AsNoTracking()
            .Where(e => e.TargetType == "post" && e.TargetId == id.ToString(CultureInfo.InvariantCulture))
            .OrderBy(e => e.Id)
            .Select(e => e.Action)
            .ToListAsync(TestContext.Current.CancellationToken);
        Assert.Equal(["post.create", "post.publish"], actions);
    }

    // The same cases MarkdownRendererTests runs against the shared renderer.
    [Theory]
    [InlineData("<script>alert(1)</script>")]
    [InlineData("<iframe src=\"https://evil.example\"></iframe>")]
    [InlineData("<object data=\"x\"></object><embed src=\"x\"><form action=\"x\"><input></form>")]
    [InlineData("<img src=x onerror=alert(1)>")]
    [InlineData("<a href=\"javascript:alert(1)\">x</a>")]
    [InlineData("[click](javascript:alert(1))")]
    [InlineData("[click](JaVaScRiPt:alert(1))")]
    [InlineData("[click]( javascript:alert(1) )")]
    [InlineData("[click](&#106;avascript:alert(1))")]
    [InlineData("![pixel](javascript:alert(1))")]
    [InlineData("<javascript:alert(1)>")]
    [InlineData("# Title {onclick=\"alert(1)\"}")]
    [InlineData("# Title {style=\"color:red\"}")]
    [InlineData("[x](https://example.com){onmouseover=\"alert(1)\"}")]
    [InlineData("```\n</code></pre><script>alert(1)</script>\n```")]
    public async Task Nothing_that_runs_script_survives_in_a_post(string markdown)
    {
        var editor = await EditorAsync();
        var body = Body("sanitized-post");
        body["bodyMarkdown"] = markdown;

        var post = await ApiClient.ReadJsonAsync(await editor.SendAsync(HttpMethod.Post, Posts, body), HttpStatusCode.Created);

        var elements = new HtmlParser().ParseDocument(post.GetProperty("bodyHtml").GetString()!).QuerySelectorAll("*");
        Assert.DoesNotContain(elements, e => _forbiddenElements.Contains(e.LocalName));
        Assert.DoesNotContain(elements.SelectMany(e => e.Attributes), a => a.Name.StartsWith("on", StringComparison.OrdinalIgnoreCase) || a.Name == "style");
        Assert.DoesNotContain(elements.SelectMany(e => e.Attributes), a => a.Value.Trim().StartsWith("javascript:", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task External_links_in_a_post_get_noopener_noreferrer_nofollow()
    {
        var editor = await EditorAsync();
        var body = Body("linked-post");
        body["bodyMarkdown"] = "[notes](https://example.com/notes) and [home](/blog)";

        var post = await ApiClient.ReadJsonAsync(await editor.SendAsync(HttpMethod.Post, Posts, body), HttpStatusCode.Created);

        var links = new HtmlParser().ParseDocument(post.GetProperty("bodyHtml").GetString()!).QuerySelectorAll("a");
        Assert.Equal(["noopener noreferrer nofollow", null], links.Select(a => a.GetAttribute("rel")));
    }

    public static TheoryData<string, string, string> InvalidFields => new()
    {
        { "slug", "\"Not A Slug\"", "slug" },
        { "slug", "\"12345\"", "slug" },
        { "title", "\"Shrt\"", "title" },
        { "excerpt", "\"Too short\"", "excerpt" },
        { "excerpt", $"\"{new string('e', 301)}\"", "excerpt" },
        { "bodyMarkdown", $"\"{new string('b', 100_001)}\"", "bodyMarkdown" },
        { "coverMediaId", "987654", "coverMediaId" },
        { "tags", "[\"x\"]", "tags[0]" },
        { "tags", "[\"ok\",\"---\"]", "tags[1]" },
        { "tags", "[\"" + string.Join("\",\"", Enumerable.Range(10, 11)) + "\"]", "tags" },
        { "status", "null", "status" },
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
        var body = Body("an-invalid-post");
        body[field] = JsonNode.Parse(json);

        var response = await editor.SendAsync(HttpMethod.Post, Posts, body);

        var problem = await ProblemAssert.IsProblemAsync(response, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), Posts);
        Assert.Contains(key, problem.GetProperty("errors").EnumerateObject().Select(p => p.Name));
    }

    [Fact]
    public async Task Every_write_leaves_an_audit_entry()
    {
        var editor = await EditorAsync();
        var (id, etag) = await CreateAsync(editor, Body("audited-post"));
        var patch = await editor.SendAsync(HttpMethod.Patch, $"{Posts}/{id}", new { title = "Audited by a patch" }, ifMatch: etag);
        Assert.Equal(HttpStatusCode.NoContent, (await editor.SendAsync(HttpMethod.Delete, $"{Posts}/{id}", ifMatch: patch.Headers.ETag?.ToString())).StatusCode);

        using var scope = _factory.Services.CreateScope();
        var actions = await scope.ServiceProvider.GetRequiredService<AppDbContext>().AuditEntries.AsNoTracking()
            .Where(e => e.TargetType == "post" && e.TargetId == id.ToString(CultureInfo.InvariantCulture))
            .OrderBy(e => e.Id)
            .Select(e => e.Action)
            .ToListAsync(TestContext.Current.CancellationToken);
        Assert.Equal(["post.create", "post.update", "post.archive"], actions);
    }

    /// <summary>A valid post, published now unless the test changes it.</summary>
    internal static JsonObject Body(
        string slug,
        string title = "How we ship the desktop app",
        string[]? tags = null,
        string status = "published",
        DateTimeOffset? publishedAt = null,
        long? coverMediaId = null) => new()
        {
            ["slug"] = slug,
            ["title"] = title,
            ["excerpt"] = "A look at the build, the tests and the release steps.",
            ["bodyMarkdown"] = "## Building\nIt starts with a tag.",
            ["coverMediaId"] = coverMediaId,
            ["tags"] = new JsonArray([.. (tags ?? ["Releases"]).Select(t => (JsonNode)t)]),
            ["status"] = status,
            ["publishedAt"] = publishedAt?.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture),
        };

    /// <summary>Creates the post and returns its id and ETag.</summary>
    internal static async Task<(long Id, string ETag)> CreateAsync(ApiClient client, JsonObject body)
    {
        var response = await client.SendAsync(HttpMethod.Post, Posts, body);
        var created = await ApiClient.ReadJsonAsync(response, HttpStatusCode.Created);
        return (created.GetProperty("id").GetInt64(), response.Headers.ETag!.ToString());
    }

    private static JsonObject? WriteBody(string method) => method switch
    {
        "PUT" => Body("changed-meanwhile"),
        "PATCH" => new JsonObject { ["title"] = "A title from a patch" },
        _ => null,
    };

    private async Task RunPublishJobAsync()
    {
        using var scope = _factory.Services.CreateScope();
        await scope.ServiceProvider.GetRequiredService<NewsPublishJob>().RunAsync(TestContext.Current.CancellationToken);
    }

    private async Task<ApiClient> EditorAsync() =>
        await TestUsers.SignedInClientAsync(_factory, await TestUsers.CreateAsync(_factory.Services, Roles.Editor));
}
