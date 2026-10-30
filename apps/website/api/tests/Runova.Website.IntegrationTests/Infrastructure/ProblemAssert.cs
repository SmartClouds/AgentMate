using System.Net;
using System.Text.Json;

namespace Runova.Website.IntegrationTests.Infrastructure;

/// <summary>Checks a response is RFC 9457 problem details in the contract's shape.</summary>
internal static class ProblemAssert
{
    /// <summary>The URI of a problem type from the contract's table.</summary>
    public static string Type(string slug) => "https://runovahq.com/problems/" + slug;

    public static async Task<JsonElement> IsProblemAsync(
        HttpResponseMessage response, HttpStatusCode status, string type, string instance)
    {
        Assert.Equal(status, response.StatusCode);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);

        var body = await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);
        using var document = JsonDocument.Parse(body);
        var problem = document.RootElement.Clone();
        Assert.Equal(type, problem.GetProperty("type").GetString());
        Assert.Equal((int)status, problem.GetProperty("status").GetInt32());
        Assert.False(string.IsNullOrWhiteSpace(problem.GetProperty("title").GetString()));
        Assert.Equal(instance, problem.GetProperty("instance").GetString());
        Assert.Matches("^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$", problem.GetProperty("traceId").GetString());
        return problem;
    }
}
