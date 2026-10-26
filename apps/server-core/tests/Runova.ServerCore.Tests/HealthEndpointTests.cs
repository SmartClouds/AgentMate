using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace Runova.ServerCore.Tests;

/// <summary>
/// The installer and the app's first connection check call health before anyone has signed in,
/// so it is the one route that must answer without credentials, and it must say which core and
/// which API version is running.
/// </summary>
public sealed class HealthEndpointTests(CoreFactory factory) : IClassFixture<CoreFactory>
{
    [Fact]
    public async Task Health_answers_without_credentials()
    {
        using var client = factory.CreateClient();

        var response = await client.GetAsync("/api/v1/health", TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>(
            TestContext.Current.CancellationToken);
        Assert.Equal("ok", body.GetProperty("status").GetString());
        Assert.Equal(CoreVersion.Current, body.GetProperty("version").GetString());
        Assert.Equal(CoreVersion.ApiVersion, body.GetProperty("apiVersion").GetInt32());
    }

    [Fact]
    public async Task Health_says_when_the_core_started_so_the_app_can_show_its_uptime()
    {
        using var client = factory.CreateClient();
        var before = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        var body = await client.GetFromJsonAsync<JsonElement>(
            "/api/v1/health",
            TestContext.Current.CancellationToken);

        var startedAt = body.GetProperty("startedAtUnixMs").GetInt64();
        Assert.InRange(startedAt, before - (10 * 60 * 1000), before + 1000);
    }

    [Fact]
    public async Task Health_uses_camel_case_json()
    {
        using var client = factory.CreateClient();

        var json = await client.GetStringAsync("/api/v1/health", TestContext.Current.CancellationToken);

        Assert.Contains("\"apiVersion\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("\"ApiVersion\"", json, StringComparison.Ordinal);
    }

    [Fact]
    public void Version_never_carries_build_metadata()
    {
        Assert.DoesNotContain('+', CoreVersion.Current);
        Assert.False(string.IsNullOrWhiteSpace(CoreVersion.Current));
    }
}
