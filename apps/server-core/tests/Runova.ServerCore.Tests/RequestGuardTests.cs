using System.Net;

namespace Runova.ServerCore.Tests;

/// <summary>
/// Browsers are never clients of the core. Any request that carries an Origin header, or that
/// names a host the core does not answer to, is turned away before authentication runs, which is
/// what stops DNS rebinding and cross-site WebSocket hijacking.
/// </summary>
public sealed class RequestGuardTests(CoreFactory factory) : IClassFixture<CoreFactory>
{
    [Theory]
    [InlineData("GET", "/api/v1/health")]
    [InlineData("POST", "/hubs/core/negotiate?negotiateVersion=1")]
    [InlineData("GET", "/hubs/core")]
    public async Task A_request_with_an_origin_is_refused_before_authentication(
        string method,
        string path)
    {
        using var client = factory.CreateClient();
        using var request = new HttpRequestMessage(new HttpMethod(method), path);
        request.Headers.Add("Origin", "https://evil.example");

        var response = await client.SendAsync(request, TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Theory]
    [InlineData("evil.example")]
    [InlineData("runova-core.evil.example")]
    [InlineData("10.0.0.5")]
    public async Task An_unknown_host_is_refused(string host)
    {
        using var client = factory.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/v1/health");
        request.Headers.Host = host;

        var response = await client.SendAsync(request, TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Theory]
    [InlineData("runova-core")]
    [InlineData("localhost")]
    [InlineData("127.0.0.1")]
    public async Task The_hosts_the_app_uses_are_accepted(string host)
    {
        using var client = factory.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/v1/health");
        request.Headers.Host = host;

        var response = await client.SendAsync(request, TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task Responses_do_not_advertise_the_server()
    {
        using var client = factory.CreateClient();

        var response = await client.GetAsync("/api/v1/health", TestContext.Current.CancellationToken);

        Assert.False(response.Headers.Contains("Server"));
    }
}
