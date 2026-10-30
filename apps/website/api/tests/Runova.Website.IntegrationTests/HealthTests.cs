using System.Net;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests;

public sealed class HealthTests(PostgresFixture postgres) : IDisposable
{
    private readonly WebsiteApiFactory _factory = new(postgres.ConnectionString);

    public void Dispose() => _factory.Dispose();

    [Fact]
    public async Task Live_answers_200()
    {
        var response = await _factory.CreateClient().GetAsync("/health/live", TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task Ready_answers_200_when_the_database_answers()
    {
        var response = await _factory.CreateClient().GetAsync("/health/ready", TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task Ready_answers_503_problem_details_once_the_database_stops()
    {
        // A container of its own, since stopping the shared one would break the other tests.
        await using var container = PostgresFixture.Create();
        await PostgresFixture.StartAsync(container);
        using var factory = new WebsiteApiFactory(container.GetConnectionString());
        var client = factory.CreateClient();
        var cancel = TestContext.Current.CancellationToken;
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/health/ready", cancel)).StatusCode);

        await container.StopAsync(cancel);
        var response = await client.GetAsync("/health/ready", cancel);

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.ServiceUnavailable, ProblemAssert.Type("unavailable"), "/health/ready");
    }

    [Fact]
    public async Task Live_stays_200_when_the_database_is_unreachable()
    {
        using var factory = new WebsiteApiFactory("Host=127.0.0.1;Port=1;Username=nobody;Password=x;Timeout=2");

        var response = await factory.CreateClient().GetAsync("/health/live", TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }
}
