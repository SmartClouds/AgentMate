using System.Net;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests;

public sealed class ProblemDetailsTests(PostgresFixture postgres) : IDisposable
{
    private readonly WebsiteApiFactory _factory = new(postgres.ConnectionString);

    public void Dispose() => _factory.Dispose();

    [Theory]
    [InlineData("/api/v1/no-such-things")]
    [InlineData("/api/v1/no-such-things/12")]
    [InlineData("/no-such-page")]
    public async Task An_unknown_route_answers_404_not_found(string path)
    {
        var response = await _factory.CreateClient().GetAsync(path, TestContext.Current.CancellationToken);

        var problem = await ProblemAssert.IsProblemAsync(response, HttpStatusCode.NotFound, ProblemAssert.Type("not-found"), path);
        Assert.False(problem.TryGetProperty("errors", out _));
    }

    [Fact]
    public async Task An_unknown_route_answers_problem_details_to_a_browser_too()
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/v1/no-such-things");
        request.Headers.Accept.ParseAdd("text/html");

        var response = await _factory.CreateClient().SendAsync(request, TestContext.Current.CancellationToken);

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.NotFound, ProblemAssert.Type("not-found"), "/api/v1/no-such-things");
    }

    // The contract has no type for 405 yet, so it answers with RFC 9457's default type.
    [Fact]
    public async Task A_wrong_method_answers_405_problem_details()
    {
        var response = await _factory.CreateClient().DeleteAsync("/openapi/v1.json", TestContext.Current.CancellationToken);

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.MethodNotAllowed, "about:blank", "/openapi/v1.json");
    }
}
