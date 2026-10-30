using System.Net;
using System.Net.Http.Headers;

namespace Runova.Website.Api.Releases;

/// <summary>
/// Reads the latest SmartClouds/Runova release from the GitHub REST API, conditionally: with the
/// ETag of the last answer, an unchanged release costs a 304 and none of the rate limit.
/// </summary>
internal sealed class GitHubReleasesClient(HttpClient http, IConfiguration configuration)
{
    public const string LatestPath = "repos/SmartClouds/Runova/releases/latest";

    /// <summary>GitHub's release body and the ETag it came with.</summary>
    public sealed record Latest(string Json, string? ETag);

    public static void Configure(HttpClient http)
    {
        http.BaseAddress = new Uri("https://api.github.com/");
        http.Timeout = TimeSpan.FromSeconds(30);
        http.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));
        http.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("Runova-Website", "1.0"));
        http.DefaultRequestHeaders.Add("X-GitHub-Api-Version", "2022-11-28");
    }

    /// <summary>
    /// The latest release, or null when it has not changed since <paramref name="etag"/>. Throws
    /// <see cref="HttpRequestException"/> when GitHub can not be reached or answers
    /// anything but 200 or 304. <c>GitHub__Token</c>, when set, raises the rate limit.
    /// </summary>
    public async Task<Latest?> GetLatestAsync(string? etag, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, LatestPath);
        if (etag is not null && EntityTagHeaderValue.TryParse(etag, out var tag))
        {
            request.Headers.IfNoneMatch.Add(tag);
        }

        if (configuration["GitHub:Token"] is { Length: > 0 } token)
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        }

        using var response = await http.SendAsync(request, cancellationToken);
        if (response.StatusCode == HttpStatusCode.NotModified)
        {
            return null;
        }

        response.EnsureSuccessStatusCode();
        return new Latest(await response.Content.ReadAsStringAsync(cancellationToken), response.Headers.ETag?.ToString());
    }
}
