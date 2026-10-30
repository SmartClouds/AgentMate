using System.Net;
using Runova.Website.Core.News;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.News;

public sealed class TechnologiesTests(PostgresFixture postgres) : IDisposable
{
    private const string Path = "/api/v1/technologies";

    private readonly WebsiteApiFactory _factory = new(postgres.ConnectionString);

    public void Dispose() => _factory.Dispose();

    [Fact]
    public async Task Anyone_gets_the_seeded_list_in_the_contract_order()
    {
        var response = await _factory.CreateApiClient().GetAsync(Path);

        var list = await ApiClient.ReadJsonAsync(response, HttpStatusCode.OK);
        Assert.Equal(Technologies.All.Select(t => t.Slug), list.EnumerateArray().Select(t => t.GetProperty("slug").GetString()));
        var first = list[0];
        Assert.Equal(["slug", "name", "kind", "detectable"], first.EnumerateObject().Select(p => p.Name));
        Assert.Equal("Runova", first.GetProperty("name").GetString());
        Assert.Equal("app", first.GetProperty("kind").GetString());
        Assert.True(first.GetProperty("detectable").GetBoolean());
        Assert.Equal("ai-cli", list.EnumerateArray().Single(t => t.GetProperty("slug").GetString() == "claude-code").GetProperty("kind").GetString());
        Assert.Equal("public, max-age=60, stale-while-revalidate=300", response.Headers.NonValidated["Cache-Control"].ToString());
    }

    [Fact]
    public async Task A_repeat_with_the_etag_answers_304()
    {
        var client = _factory.CreateApiClient();
        var first = await client.GetAsync(Path);
        Assert.NotNull(first.Headers.ETag);

        var request = new HttpRequestMessage(HttpMethod.Get, Path);
        request.Headers.TryAddWithoutValidation("If-None-Match", first.Headers.ETag.ToString());
        var repeat = await client.Http.SendAsync(request, TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.NotModified, repeat.StatusCode);
        Assert.Equal(first.Headers.ETag, repeat.Headers.ETag);
    }
}
