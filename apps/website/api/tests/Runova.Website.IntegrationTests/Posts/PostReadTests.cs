using System.Net;
using System.Text.Json;
using Microsoft.Extensions.Time.Testing;
using Runova.Website.Core.News;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Posts;

public sealed class PostReadTests(PostgresFixture postgres) : IAsyncLifetime
{
    private const string Posts = "/api/v1/posts";
    private const string Tags = "/api/v1/tags";
    private const string ListCaching = "public, max-age=60, stale-while-revalidate=300";
    private const string ItemCaching = "public, max-age=300, stale-while-revalidate=600";

    // The properties of the contract's PostListItemDto, in order, and nothing else.
    private static readonly string[] _listItemProperties =
    [
        "id", "slug", "url", "title", "excerpt", "coverImage", "tags", "author", "publishedAt", "updatedAt", "readingTimeMinutes",
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
    public async Task Only_published_posts_whose_time_has_come_are_listed_newest_first()
    {
        await TestPosts.AddAsync(
            _factory.Services,
            TestPosts.Item("older-published", _now.AddHours(-3)),
            TestPosts.Item("a-draft", null, NewsStatus.Draft),
            TestPosts.Item("a-scheduled-one", _now.AddHours(1), NewsStatus.Scheduled),
            TestPosts.Item("an-archived-one", _now.AddHours(-2), NewsStatus.Archived),
            TestPosts.Item("published-in-the-future", _now.AddHours(1)),
            TestPosts.Item("newer-published", _now.AddHours(-1)));

        var page = await ListAsync("");

        Assert.Equal(["newer-published", "older-published"], Slugs(page));
        Assert.Equal(2, page.GetProperty("totalItems").GetInt32());
    }

    [Fact]
    public async Task Pages_carry_the_paging_metadata_and_links()
    {
        await TestPosts.AddAsync(
            _factory.Services,
            TestPosts.Item("first-post", _now.AddHours(-1)),
            TestPosts.Item("second-post", _now.AddHours(-2)),
            TestPosts.Item("third-post", _now.AddHours(-3)));

        var first = await GetAsync($"{Posts}?pageSize=2");
        var page = await ApiClient.ReadJsonAsync(first, HttpStatusCode.OK);
        var past = await ListAsync("pageSize=2&page=3");

        Assert.Equal(["items", "page", "pageSize", "totalItems", "totalPages"], page.EnumerateObject().Select(p => p.Name));
        Assert.Equal(["first-post", "second-post"], Slugs(page));
        Assert.Equal(1, page.GetProperty("page").GetInt32());
        Assert.Equal(2, page.GetProperty("pageSize").GetInt32());
        Assert.Equal(3, page.GetProperty("totalItems").GetInt32());
        Assert.Equal(2, page.GetProperty("totalPages").GetInt32());
        Assert.Contains($"<{Posts}?pageSize=2&page=2>; rel=\"next\"", first.Headers.GetValues("Link").Single(), StringComparison.Ordinal);
        Assert.Empty(Slugs(past));
    }

    [Theory]
    [InlineData("tag=docker", "docker-tips security-notes")]
    [InlineData("tag=docker&tag=ai", "ai-agents docker-tips security-notes")]
    [InlineData("q=containers", "docker-tips")]
    [InlineData("q=agents", "ai-agents")]
    [InlineData("tag=docker&q=sandbox", "security-notes")]
    public async Task Tag_and_search_filters_work_alone_and_combined(string query, string expected)
    {
        await TestPosts.AddAsync(
            _factory.Services,
            TestPosts.Item("ai-agents", _now.AddHours(-1), title: "How we run agents", body: "Agents write code for us.", tags: ["AI"]),
            TestPosts.Item("docker-tips", _now.AddHours(-2), title: "Docker tips", body: "Keep containers small.", tags: ["Docker"]),
            TestPosts.Item("security-notes", _now.AddHours(-3), title: "Security notes", body: "A sandbox for every run.", tags: ["Docker", "Security"]));

        var page = await ListAsync(query);

        Assert.Equal(expected.Split(' '), Slugs(page).Order());
    }

    [Theory]
    [InlineData("pageSize=101", "pageSize")]
    [InlineData("page=0", "page")]
    [InlineData("q=a", "q")]
    [InlineData("status=bogus", "status")]
    public async Task A_bad_parameter_answers_400_naming_it(string query, string parameter)
    {
        var response = await GetAsync($"{Posts}?{query}");

        var problem = await ProblemAssert.IsProblemAsync(response, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), Posts);
        Assert.Equal([parameter], problem.GetProperty("errors").EnumerateObject().Select(p => p.Name));
    }

    [Fact]
    public async Task A_list_item_has_the_contract_fields()
    {
        var body = string.Join(' ', Enumerable.Repeat("word", 231));
        await TestPosts.AddAsync(_factory.Services, TestPosts.Item("a-long-read", _now.AddHours(-1), body: body, tags: ["Dev Tools"]));

        var response = await GetAsync(Posts);
        var dto = (await ApiClient.ReadJsonAsync(response, HttpStatusCode.OK)).GetProperty("items")[0];

        Assert.Equal(_listItemProperties, dto.EnumerateObject().Select(p => p.Name));
        Assert.Equal("https://runovahq.com/blog/a-long-read", dto.GetProperty("url").GetString());
        Assert.Equal(JsonValueKind.Null, dto.GetProperty("coverImage").ValueKind);
        Assert.Equal("dev-tools", dto.GetProperty("tags")[0].GetProperty("slug").GetString());
        Assert.Equal("Dev Tools", dto.GetProperty("tags")[0].GetProperty("name").GetString());
        Assert.Equal(["displayName"], dto.GetProperty("author").EnumerateObject().Select(p => p.Name));
        Assert.Equal("Sam Writer", dto.GetProperty("author").GetProperty("displayName").GetString());
        Assert.Equal(2, dto.GetProperty("readingTimeMinutes").GetInt32());
        Assert.Equal("2026-10-30T11:00:00.000Z", dto.GetProperty("publishedAt").GetString());
        Assert.True(response.Headers.ETag?.IsWeak);
        Assert.Equal(ListCaching, CacheControl(response));
    }

    [Fact]
    public async Task A_post_is_read_by_its_slug_with_its_html_and_etag_and_a_repeat_answers_304()
    {
        await TestPosts.AddAsync(_factory.Services, TestPosts.Item("hello-blog", _now.AddHours(-1), body: "## Hello\n\nSee [docs](https://example.com)."));

        var response = await GetAsync($"{Posts}/hello-blog");
        var dto = await ApiClient.ReadJsonAsync(response, HttpStatusCode.OK);
        var repeat = await GetAsync($"{Posts}/hello-blog", response.Headers.ETag!.ToString());

        Assert.Equal([.. _listItemProperties, "bodyHtml"], dto.EnumerateObject().Select(p => p.Name));
        Assert.Contains("<h2 id=\"hello\">Hello</h2>", dto.GetProperty("bodyHtml").GetString(), StringComparison.Ordinal);
        Assert.Contains("rel=\"noopener noreferrer nofollow\"", dto.GetProperty("bodyHtml").GetString(), StringComparison.Ordinal);
        Assert.False(response.Headers.ETag.IsWeak);
        Assert.Equal(ItemCaching, CacheControl(response));
        Assert.Equal(HttpStatusCode.NotModified, repeat.StatusCode);
    }

    [Theory]
    [InlineData("a-draft")]
    [InlineData("a-scheduled-one")]
    [InlineData("an-archived-one")]
    [InlineData("no-such-post")]
    public async Task Anything_not_published_answers_404(string slug)
    {
        await TestPosts.AddAsync(
            _factory.Services,
            TestPosts.Item("a-draft", null, NewsStatus.Draft),
            TestPosts.Item("a-scheduled-one", _now.AddHours(1), NewsStatus.Scheduled),
            TestPosts.Item("an-archived-one", _now.AddHours(-2), NewsStatus.Archived));

        var response = await GetAsync($"{Posts}/{slug}");

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.NotFound, ProblemAssert.Type("not-found"), $"{Posts}/{slug}");
    }

    [Fact]
    public async Task Listing_by_status_needs_staff()
    {
        await TestPosts.AddAsync(_factory.Services, TestPosts.Item("a-draft", null, NewsStatus.Draft));
        var editor = await TestUsers.SignedInClientAsync(_factory, await TestUsers.CreateAsync(_factory.Services));

        var anonymous = await GetAsync($"{Posts}?status=draft");
        var staff = await editor.GetAsync($"{Posts}?status=draft");

        await ProblemAssert.IsProblemAsync(anonymous, HttpStatusCode.Unauthorized, ProblemAssert.Type("unauthorized"), Posts);
        Assert.Equal(["a-draft"], Slugs(await ApiClient.ReadJsonAsync(staff, HttpStatusCode.OK)));
        Assert.Equal("private, no-store", CacheControl(staff));
    }

    [Fact]
    public async Task Tags_count_only_published_posts_and_a_repeat_answers_304()
    {
        await TestPosts.AddAsync(
            _factory.Services,
            TestPosts.Item("first-post", _now.AddHours(-1), tags: ["Docker", "AI"]),
            TestPosts.Item("second-post", _now.AddHours(-2), tags: ["Docker"]),
            TestPosts.Item("a-draft", null, NewsStatus.Draft, tags: ["Docker", "Drafts"]));

        var response = await GetAsync(Tags);
        var tags = await ApiClient.ReadJsonAsync(response, HttpStatusCode.OK);
        var repeat = await GetAsync(Tags, response.Headers.ETag!.ToString());

        Assert.Equal(
            ["ai AI 1", "docker Docker 2"],
            tags.EnumerateArray().Select(t => $"{t.GetProperty("slug").GetString()} {t.GetProperty("name").GetString()} {t.GetProperty("postCount").GetInt32()}"));
        Assert.Equal(["slug", "name", "postCount"], tags[0].EnumerateObject().Select(p => p.Name));
        Assert.Equal(HttpStatusCode.NotModified, repeat.StatusCode);
    }

    private async Task<JsonElement> ListAsync(string query) =>
        await ApiClient.ReadJsonAsync(await GetAsync(query.Length == 0 ? Posts : $"{Posts}?{query}"), HttpStatusCode.OK);

    private Task<HttpResponseMessage> GetAsync(string path, string? ifNoneMatch = null)
    {
        var request = new HttpRequestMessage(HttpMethod.Get, path);
        if (ifNoneMatch is not null)
        {
            request.Headers.TryAddWithoutValidation("If-None-Match", ifNoneMatch);
        }

        return _factory.CreateApiClient().Http.SendAsync(request, TestContext.Current.CancellationToken);
    }

    private static List<string?> Slugs(JsonElement page) =>
        [.. page.GetProperty("items").EnumerateArray().Select(i => i.GetProperty("slug").GetString())];

    private static string CacheControl(HttpResponseMessage response) =>
        response.Headers.NonValidated["Cache-Control"].ToString();
}
