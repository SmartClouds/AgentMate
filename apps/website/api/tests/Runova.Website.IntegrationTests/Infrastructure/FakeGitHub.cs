using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Headers;
using Microsoft.Extensions.DependencyInjection;
using Runova.Website.Api.Releases;

namespace Runova.Website.IntegrationTests.Infrastructure;

/// <summary>
/// Stands in for api.github.com behind the release sync's HTTP client. It answers each request
/// with the reply a test set last and keeps every request it saw.
/// </summary>
internal sealed class FakeGitHub
{
    public const string ETag = "W/\"recorded-v2.2.0\"";

    private readonly ConcurrentQueue<HttpRequestMessage> _requests = new();
    private Func<HttpRequestMessage, HttpResponseMessage> _reply = _ => new HttpResponseMessage(HttpStatusCode.NotFound);

    public IReadOnlyList<HttpRequestMessage> Requests => [.. _requests];

    /// <summary>The release GitHub sent for v2.2.0, recorded once and kept with the tests.</summary>
    public static string RecordedRelease() =>
        File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "Releases", "github-release-v2.2.0.json"));

    /// <summary>A 200 with this release body and ETag.</summary>
    public void Sends(string json, string etag = ETag) => _reply = _ =>
    {
        var response = new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json, MediaTypeHeaderValue.Parse("application/json")) };
        response.Headers.ETag = EntityTagHeaderValue.Parse(etag);
        return response;
    };

    /// <summary>A 304 when the request names <paramref name="etag"/> in <c>If-None-Match</c>, else the recorded release.</summary>
    public void SendsNotModifiedFor(string etag = ETag) => _reply = request =>
        request.Headers.IfNoneMatch.Any(t => t.ToString() == etag)
            ? new HttpResponseMessage(HttpStatusCode.NotModified)
            : throw new InvalidOperationException("The sync did not send the stored ETag.");

    public void Answers(HttpStatusCode status) => _reply = _ => new HttpResponseMessage(status) { Content = new StringContent("{\"message\":\"no\"}") };

    /// <summary>As when GitHub can not be reached at all.</summary>
    public void IsUnreachable() => _reply = _ => throw new HttpRequestException("api.github.com could not be reached (fake).");

    /// <summary>Puts this fake under the release sync's HTTP client, in place of the network.</summary>
    public void Register(IServiceCollection services) =>
        services.AddHttpClient<GitHubReleasesClient>().ConfigurePrimaryHttpMessageHandler(() => new Handler(this));

    // The client factory disposes its handlers when it rotates them, so each gets a new one.
    private sealed class Handler(FakeGitHub github) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            github._requests.Enqueue(request);
            return Task.FromResult(github._reply(request));
        }
    }
}
