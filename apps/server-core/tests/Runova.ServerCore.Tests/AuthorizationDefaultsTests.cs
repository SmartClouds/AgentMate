using System.Net;

namespace Runova.ServerCore.Tests;

/// <summary>
/// Nothing is reachable by accident: routes nobody mapped, the hub and its negotiate endpoint all
/// ask for credentials, and until sign-in exists (E04) nothing can present any.
/// </summary>
public sealed class AuthorizationDefaultsTests(CoreFactory factory) : IClassFixture<CoreFactory>
{
    [Theory]
    [InlineData("GET", "/api/v1/nothing-here")]
    [InlineData("GET", "/")]
    [InlineData("GET", "/hubs/core")]
    [InlineData("POST", "/hubs/core/negotiate?negotiateVersion=1")]
    public async Task Everything_but_health_requires_credentials(string method, string path)
    {
        using var client = factory.CreateClient();
        using var request = new HttpRequestMessage(new HttpMethod(method), path);

        var response = await client.SendAsync(request, TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task A_bearer_token_is_not_accepted_before_sign_in_exists()
    {
        using var client = factory.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Post, "/hubs/core/negotiate?negotiateVersion=1");
        request.Headers.Authorization = new("Bearer", "made-up-token");

        var response = await client.SendAsync(request, TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }
}
