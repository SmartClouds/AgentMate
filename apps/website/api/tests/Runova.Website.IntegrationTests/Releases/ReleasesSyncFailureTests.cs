using System.Net;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;
using Runova.Website.IntegrationTests.Infrastructure;
using Sentry;
using Sentry.AspNetCore;

namespace Runova.Website.IntegrationTests.Releases;

[Collection(TelemetryTestGroup.Name)]
public sealed class ReleasesSyncFailureTests(PostgresFixture postgres)
{
    public enum Failure
    {
        Unreachable,
        ServerError,
        RateLimited,
        NotARelease,
    }

    [Theory]
    [InlineData(Failure.Unreachable, "api.github.com could not be reached (fake).")]
    [InlineData(Failure.ServerError, "500")]
    [InlineData(Failure.RateLimited, "403")]
    [InlineData(Failure.NotARelease, "JSON")]
    public async Task When_GitHub_fails_the_last_release_keeps_being_served_and_Sentry_hears_of_it(Failure failure, string reported)
    {
        var time = new FakeTimeProvider(new DateTimeOffset(2026, 10, 30, 12, 0, 0, TimeSpan.Zero));
        var github = new FakeGitHub();
        var transport = new FakeSentryTransport();
        using var factory = new WebsiteApiFactory(
            await postgres.CreateDatabaseAsync(),
            time: time,
            settings: new Dictionary<string, string> { ["Sentry:Dsn"] = FakeSentryTransport.Dsn },
            services: services =>
            {
                github.Register(services);
                services.Configure<SentryAspNetCoreOptions>(options => options.Transport = transport);
            });
        var client = factory.CreateApiClient();
        github.Sends(FakeGitHub.RecordedRelease());
        await ReleasesSyncJobTests.RunJobAsync(factory);
        var served = await (await client.GetAsync("/api/v1/releases/latest")).Content.ReadAsStringAsync(TestContext.Current.CancellationToken);

        time.Advance(TimeSpan.FromMinutes(15));
        switch (failure)
        {
            case Failure.Unreachable:
                github.IsUnreachable();
                break;
            case Failure.ServerError:
                github.Answers(HttpStatusCode.InternalServerError);
                break;
            case Failure.RateLimited:
                github.Answers(HttpStatusCode.Forbidden);
                break;
            case Failure.NotARelease:
                github.Sends("{\"message\":\"this is not a release\"}");
                break;
        }

        await ReleasesSyncJobTests.RunJobAsync(factory);

        var response = await client.GetAsync("/api/v1/releases/latest");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(served, await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken));
        await SentrySdk.FlushAsync(TimeSpan.FromSeconds(5));
        Assert.Contains(
            transport.Events,
            e => e.TryGetProperty("exception", out var exception) && exception.ToString().Contains(reported, StringComparison.Ordinal));
    }
}
