using System.Net;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests;

public sealed class OpenApiTests(PostgresFixture postgres)
{
    [Fact]
    public async Task The_document_matches_its_snapshot()
    {
        using var factory = new WebsiteApiFactory(postgres.ConnectionString);

        var response = await factory.CreateClient().GetAsync("/openapi/v1.json", TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("application/json", response.Content.Headers.ContentType?.MediaType);
        await Snapshot.MatchesJsonAsync("openapi-v1", await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken));
    }

    [Theory]
    [InlineData("Development", HttpStatusCode.OK)]
    [InlineData("Staging", HttpStatusCode.OK)]
    [InlineData("Production", HttpStatusCode.NotFound)]
    public async Task The_scalar_page_is_served_outside_production_only(string environment, HttpStatusCode expected)
    {
        using var factory = new WebsiteApiFactory(postgres.ConnectionString, environment);

        var response = await factory.CreateClient().GetAsync("/scalar", TestContext.Current.CancellationToken);

        Assert.Equal(expected, response.StatusCode);
    }
}
