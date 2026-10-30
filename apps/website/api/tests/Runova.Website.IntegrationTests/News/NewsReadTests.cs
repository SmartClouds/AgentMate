using System.Net;
using System.Text.Json;
using Microsoft.Extensions.Time.Testing;
using Runova.Website.Core.News;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.News;

public sealed class NewsReadTests(PostgresFixture postgres) : IAsyncLifetime
{
    private const string News = "/api/v1/news";
    private const string ListCaching = "public, max-age=60, stale-while-revalidate=300";
    private const string ItemCaching = "public, max-age=300, stale-while-revalidate=600";

    // The properties of the contract's NewsListItemDto, in order, and nothing else.
    private static readonly string[] _listItemProperties =
    [
        "id", "slug", "url", "title", "summary", "category", "severity", "technologies", "cveIds", "cvssScore",
        "tags", "publishedAt", "updatedAt",
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
    public async Task Only_published_items_whose_time_has_come_are_listed_newest_first()
    {
        await TestNews.AddAsync(
            _factory.Services,
            TestNews.Item("older-published", _now.AddHours(-3)),
            TestNews.Item("a-draft", null, NewsStatus.Draft),
            TestNews.Item("a-scheduled-one", _now.AddHours(1), NewsStatus.Scheduled),
            TestNews.Item("an-archived-one", _now.AddHours(-2), NewsStatus.Archived),
            TestNews.Item("published-in-the-future", _now.AddHours(1)),
            TestNews.Item("newer-published", _now.AddHours(-1)),
            TestNews.Item("published-this-instant", _now));

        var page = await ListAsync("");

        Assert.Equal(["published-this-instant", "newer-published", "older-published"], Slugs(page));
        Assert.Equal(3, page.GetProperty("totalItems").GetInt32());
    }

    [Fact]
    public async Task An_item_shows_up_once_its_time_comes()
    {
        await TestNews.AddAsync(_factory.Services, TestNews.Item("comes-later", _now.AddMinutes(5)));
        Assert.Empty(Slugs(await ListAsync("")));

        _time.Advance(TimeSpan.FromMinutes(5));

        Assert.Equal(["comes-later"], Slugs(await ListAsync("")));
    }

    [Theory]
    [InlineData("", "openssh-crash node-release git-clone python-eol")]
    [InlineData("category=security", "openssh-crash git-clone")]
    [InlineData("category=release&category=end-of-life", "node-release python-eol")]
    [InlineData("severity=high", "openssh-crash")]
    [InlineData("severity=info&severity=critical", "node-release git-clone python-eol")]
    [InlineData("minSeverity=high", "openssh-crash git-clone")]
    [InlineData("minSeverity=critical", "git-clone")]
    [InlineData("technology=git", "git-clone")]
    [InlineData("technology=openssh&technology=python", "openssh-crash python-eol")]
    [InlineData("tag=servers", "openssh-crash python-eol")]
    [InlineData("tag=ssh&tag=git", "openssh-crash git-clone")]
    [InlineData("since=2026-10-29T12:00:00.000Z", "openssh-crash node-release")]
    [InlineData("since=2026-10-30T10:00:00.000Z", "openssh-crash node-release")]
    [InlineData("q=crash", "openssh-crash")]
    [InlineData("q=crafted", "openssh-crash git-clone")]
    [InlineData("q=fixes%20-clone", "openssh-crash python-eol")]
    [InlineData("q=permission", "node-release")]
    [InlineData("category=security&tag=servers", "openssh-crash")]
    [InlineData("category=release&technology=git", "")]
    [InlineData("category=security&minSeverity=critical&technology=git&tag=git&since=2026-10-28T00:00:00.000Z&q=clone", "git-clone")]
    [InlineData("sort=publishedAt", "python-eol git-clone node-release openssh-crash")]
    [InlineData("sort=-publishedAt", "openssh-crash node-release git-clone python-eol")]
    [InlineData("sort=-severity", "git-clone openssh-crash node-release python-eol")]
    [InlineData("sort=-severity&category=security", "git-clone openssh-crash")]
    public async Task Filters_work_alone_and_combined(string query, string expected)
    {
        await AddFilterSetAsync();

        var page = await ListAsync(query);

        Assert.Equal(expected.Split(' ', StringSplitOptions.RemoveEmptyEntries), Slugs(page));
        Assert.Equal(Slugs(page).Count, page.GetProperty("totalItems").GetInt32());
    }

    [Theory]
    [InlineData("pageSize=101", "pageSize")]
    [InlineData("pageSize=0", "pageSize")]
    [InlineData("page=0", "page")]
    [InlineData("category=bogus", "category")]
    [InlineData("category=Security", "category")]
    [InlineData("severity=severe", "severity")]
    [InlineData("minSeverity=0", "minSeverity")]
    [InlineData("technology=node", "technology")]
    [InlineData("q=a", "q")]
    [InlineData("since=yesterday", "since")]
    [InlineData("sort=title", "sort")]
    [InlineData("status=bogus", "status")]
    public async Task A_bad_parameter_answers_400_naming_it(string query, string parameter)
    {
        var response = await _factory.CreateApiClient().GetAsync($"{News}?{query}");

        var problem = await ProblemAssert.IsProblemAsync(response, HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), News);
        Assert.Equal([parameter], problem.GetProperty("errors").EnumerateObject().Select(p => p.Name));
    }

    [Fact]
    public async Task Pages_come_with_totals_and_links_and_a_page_past_the_end_is_empty()
    {
        await TestNews.AddAsync(
            _factory.Services,
            TestNews.Item("first-item", _now.AddHours(-1)),
            TestNews.Item("second-item", _now.AddHours(-2)),
            TestNews.Item("third-item", _now.AddHours(-3)));
        var client = _factory.CreateApiClient();

        var first = await client.GetAsync($"{News}?pageSize=2");
        var firstPage = await ApiClient.ReadJsonAsync(first, HttpStatusCode.OK);
        var second = await ListAsync("pageSize=2&page=2");
        var past = await ListAsync("pageSize=2&page=3");

        Assert.Equal(["first-item", "second-item"], Slugs(firstPage));
        Assert.Equal(1, firstPage.GetProperty("page").GetInt32());
        Assert.Equal(2, firstPage.GetProperty("pageSize").GetInt32());
        Assert.Equal(3, firstPage.GetProperty("totalItems").GetInt32());
        Assert.Equal(2, firstPage.GetProperty("totalPages").GetInt32());
        Assert.Contains($"<{News}?pageSize=2&page=2>; rel=\"next\"", first.Headers.GetValues("Link").Single(), StringComparison.Ordinal);
        Assert.Equal(["third-item"], Slugs(second));
        Assert.Empty(Slugs(past));
        Assert.Equal(3, past.GetProperty("page").GetInt32());
    }

    [Fact]
    public async Task A_list_item_has_the_contract_fields_with_lowercase_enums()
    {
        var item = TestNews.Item(
            "python-3-9-reaches-end-of-life",
            _now.AddHours(-1),
            category: NewsCategory.EndOfLife,
            technologies: ["python"],
            tags: ["python"]);
        item.Technologies[0].FixedIn = "3.10.0";
        item.CveIds = ["CVE-2026-41234"];
        item.CvssScore = 7.5m;
        await TestNews.AddAsync(_factory.Services, item);

        var dto = (await ListAsync("")).GetProperty("items")[0];

        Assert.Equal(_listItemProperties, dto.EnumerateObject().Select(p => p.Name));
        Assert.Equal(item.Id, dto.GetProperty("id").GetInt64());
        Assert.Equal("https://runovahq.com/news/python-3-9-reaches-end-of-life", dto.GetProperty("url").GetString());
        Assert.Equal("end-of-life", dto.GetProperty("category").GetString());
        Assert.Equal("info", dto.GetProperty("severity").GetString());
        var technology = dto.GetProperty("technologies")[0];
        Assert.Equal(["technology", "name", "versionRange", "fixedIn"], technology.EnumerateObject().Select(p => p.Name));
        Assert.Equal("python", technology.GetProperty("technology").GetString());
        Assert.Equal("Python", technology.GetProperty("name").GetString());
        Assert.Equal("3.10.0", technology.GetProperty("fixedIn").GetString());
        Assert.Equal(["CVE-2026-41234"], dto.GetProperty("cveIds").EnumerateArray().Select(c => c.GetString()));
        Assert.Equal(7.5m, dto.GetProperty("cvssScore").GetDecimal());
        Assert.Equal("2026-10-30T11:00:00.000Z", dto.GetProperty("publishedAt").GetString());
    }

    [Fact]
    public async Task Security_severities_serialize_lowercase()
    {
        await TestNews.AddAsync(
            _factory.Services,
            TestNews.Item("a-critical-one", _now.AddHours(-1), category: NewsCategory.Security, severity: NewsSeverity.Critical, technologies: ["git"]));

        var dto = (await ListAsync("")).GetProperty("items")[0];

        Assert.Equal("security", dto.GetProperty("category").GetString());
        Assert.Equal("critical", dto.GetProperty("severity").GetString());
    }

    [Fact]
    public async Task A_list_carries_a_weak_etag_and_a_repeat_with_it_answers_304_until_something_changes()
    {
        await TestNews.AddAsync(_factory.Services, TestNews.Item("first-item", _now.AddHours(-1)));

        var first = await GetAsync($"{News}?category=industry");
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        var etag = first.Headers.ETag;
        Assert.NotNull(etag);
        Assert.True(etag.IsWeak);
        Assert.Equal(ListCaching, CacheControl(first));

        var repeat = await GetAsync($"{News}?category=industry", etag.ToString());
        Assert.Equal(HttpStatusCode.NotModified, repeat.StatusCode);
        Assert.Empty(await repeat.Content.ReadAsByteArrayAsync(TestContext.Current.CancellationToken));
        Assert.Equal(etag, repeat.Headers.ETag);
        Assert.Equal(ListCaching, CacheControl(repeat));

        var otherQuery = await GetAsync($"{News}?category=industry&page=1", etag.ToString());
        Assert.Equal(HttpStatusCode.OK, otherQuery.StatusCode);

        await TestNews.AddAsync(_factory.Services, TestNews.Item("second-item", _now.AddHours(-2)));
        var afterAdd = await GetAsync($"{News}?category=industry", etag.ToString());
        Assert.Equal(HttpStatusCode.OK, afterAdd.StatusCode);
        Assert.NotEqual(etag, afterAdd.Headers.ETag);
    }

    [Fact]
    public async Task An_item_is_read_by_its_slug_with_its_body_sources_and_etag()
    {
        var item = TestNews.Item(
            "openssh-10-3-fixes-a-pre-auth-crash",
            _now.AddHours(-1),
            category: NewsCategory.Security,
            severity: NewsSeverity.High,
            body: "## What happened\n\nSee [the notes](https://www.openssh.com/txt/release-10.3).",
            technologies: ["openssh"]);
        item.SourceLinks = [new SourceLink { Title = "OpenSSH 10.3 release notes", Url = "https://www.openssh.com/txt/release-10.3" }];
        await TestNews.AddAsync(_factory.Services, item);

        var response = await GetAsync($"{News}/openssh-10-3-fixes-a-pre-auth-crash");

        var dto = await ApiClient.ReadJsonAsync(response, HttpStatusCode.OK);
        Assert.Equal([.. _listItemProperties, "bodyHtml", "sourceLinks"], dto.EnumerateObject().Select(p => p.Name));
        Assert.Equal("security", dto.GetProperty("category").GetString());
        Assert.Equal("high", dto.GetProperty("severity").GetString());
        Assert.Contains("<h2 id=\"what-happened\">What happened</h2>", dto.GetProperty("bodyHtml").GetString(), StringComparison.Ordinal);
        Assert.Contains("rel=\"noopener noreferrer nofollow\"", dto.GetProperty("bodyHtml").GetString(), StringComparison.Ordinal);
        var source = dto.GetProperty("sourceLinks")[0];
        Assert.Equal("OpenSSH 10.3 release notes", source.GetProperty("title").GetString());
        Assert.Equal("https://www.openssh.com/txt/release-10.3", source.GetProperty("url").GetString());
        Assert.NotNull(response.Headers.ETag);
        Assert.False(response.Headers.ETag.IsWeak);
        Assert.Matches("^\"[0-9]+\"$", response.Headers.ETag.Tag);
        Assert.Equal(ItemCaching, CacheControl(response));
    }

    [Fact]
    public async Task A_repeat_read_of_an_item_with_its_etag_answers_304()
    {
        await TestNews.AddAsync(_factory.Services, TestNews.Item("first-item", _now.AddHours(-1)));
        var first = await GetAsync($"{News}/first-item");
        var etag = first.Headers.ETag!.ToString();

        var repeat = await GetAsync($"{News}/first-item", etag);
        var weakRepeat = await GetAsync($"{News}/first-item", "W/" + etag);
        var oneOfMany = await GetAsync($"{News}/first-item", $"\"1\", {etag}");
        var stale = await GetAsync($"{News}/first-item", "\"1\"");

        Assert.Equal(HttpStatusCode.NotModified, repeat.StatusCode);
        Assert.Empty(await repeat.Content.ReadAsByteArrayAsync(TestContext.Current.CancellationToken));
        Assert.Equal(etag, repeat.Headers.ETag?.ToString());
        Assert.Equal(ItemCaching, CacheControl(repeat));
        Assert.Equal(HttpStatusCode.NotModified, weakRepeat.StatusCode);
        Assert.Equal(HttpStatusCode.NotModified, oneOfMany.StatusCode);
        Assert.Equal(HttpStatusCode.OK, stale.StatusCode);
    }

    [Theory]
    [InlineData("a-draft")]
    [InlineData("a-scheduled-one")]
    [InlineData("an-archived-one")]
    [InlineData("published-in-the-future")]
    [InlineData("no-such-item")]
    [InlineData("Not-A-Slug")]
    public async Task Anything_not_published_answers_404(string slug)
    {
        await TestNews.AddAsync(
            _factory.Services,
            TestNews.Item("a-draft", null, NewsStatus.Draft),
            TestNews.Item("a-scheduled-one", _now.AddHours(1), NewsStatus.Scheduled),
            TestNews.Item("an-archived-one", _now.AddHours(-2), NewsStatus.Archived),
            TestNews.Item("published-in-the-future", _now.AddHours(1)));

        var response = await GetAsync($"{News}/{slug}");

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.NotFound, ProblemAssert.Type("not-found"), $"{News}/{slug}");
    }

    [Fact]
    public async Task An_anonymous_status_filter_answers_401()
    {
        var response = await GetAsync($"{News}?status=draft");

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.Unauthorized, ProblemAssert.Type("unauthorized"), News);
    }

    [Fact]
    public async Task Staff_can_list_by_status()
    {
        await TestNews.AddAsync(
            _factory.Services,
            TestNews.Item("a-draft", null, NewsStatus.Draft),
            TestNews.Item("a-scheduled-one", _now.AddHours(1), NewsStatus.Scheduled),
            TestNews.Item("a-published-one", _now.AddHours(-1)));
        var editor = await TestUsers.SignedInClientAsync(_factory, await TestUsers.CreateAsync(_factory.Services));

        var drafts = await ApiClient.ReadJsonAsync(await editor.GetAsync($"{News}?status=draft&status=scheduled&sort=publishedAt"), HttpStatusCode.OK);
        var plain = await ApiClient.ReadJsonAsync(await editor.GetAsync(News), HttpStatusCode.OK);

        Assert.Equal(["a-scheduled-one", "a-draft"], Slugs(drafts));
        Assert.Equal(JsonValueKind.Null, drafts.GetProperty("items")[1].GetProperty("publishedAt").ValueKind);
        Assert.Equal(["a-published-one"], Slugs(plain));
    }

    [Fact]
    public async Task A_staff_list_is_never_cached_by_a_shared_cache()
    {
        await TestNews.AddAsync(_factory.Services, TestNews.Item("a-draft", null, NewsStatus.Draft));
        var editor = await TestUsers.SignedInClientAsync(_factory, await TestUsers.CreateAsync(_factory.Services));

        var response = await editor.GetAsync($"{News}?status=draft");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("private, no-store", CacheControl(response));
    }

    // Four published items, one per kind of filter value, oldest last.
    private Task AddFilterSetAsync() =>
        TestNews.AddAsync(
            _factory.Services,
            TestNews.Item(
                "openssh-crash",
                _now.AddHours(-1),
                category: NewsCategory.Security,
                severity: NewsSeverity.High,
                title: "OpenSSH 10.3 fixes a pre-auth crash",
                summary: "A crafted key exchange can crash sshd before sign-in. Update to 10.3.",
                body: "## What happened\n\nThe key exchange code reads past a buffer.",
                technologies: ["openssh"],
                tags: ["ssh", "servers"]),
            TestNews.Item(
                "node-release",
                _now.AddHours(-2),
                category: NewsCategory.Release,
                title: "Node.js 24.3 is out",
                summary: "The new release adds flags and ships a newer V8.",
                body: "New permission model flags.",
                technologies: ["nodejs"],
                tags: ["node"]),
            TestNews.Item(
                "git-clone",
                _now.AddHours(-30),
                category: NewsCategory.Security,
                severity: NewsSeverity.Critical,
                title: "Git fixes a clone exploit",
                summary: "Cloning a hostile repository could run its code.",
                body: "A crafted repository runs code on clone.",
                technologies: ["git"],
                tags: ["git"]),
            TestNews.Item(
                "python-eol",
                _now.AddHours(-50),
                category: NewsCategory.EndOfLife,
                title: "Python 3.9 reaches end of life",
                summary: "Python 3.9 gets no more updates from today on.",
                body: "No more security fixes.",
                technologies: ["python"],
                tags: ["python", "servers"]));

    private async Task<JsonElement> ListAsync(string query) =>
        await ApiClient.ReadJsonAsync(await GetAsync(query.Length == 0 ? News : $"{News}?{query}"), HttpStatusCode.OK);

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
