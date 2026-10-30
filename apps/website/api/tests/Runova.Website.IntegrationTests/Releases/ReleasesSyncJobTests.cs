using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;
using Runova.Website.Api.Releases;
using Runova.Website.Core.Releases;
using Runova.Website.Data;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Releases;

public sealed class ReleasesSyncJobTests(PostgresFixture postgres) : IAsyncLifetime
{
    private static readonly DateTimeOffset _now = new(2026, 10, 30, 12, 0, 0, TimeSpan.Zero);

    private readonly FakeTimeProvider _time = new(_now);
    private readonly FakeGitHub _github = new();
    private readonly DatabaseWrites _writes = new();
    private string _database = null!;

    // A database of its own: the latest release is whatever was fetched last, across the whole table.
    public async ValueTask InitializeAsync() => _database = await postgres.CreateDatabaseAsync();

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task A_200_stores_the_release_with_its_desktop_assets_and_GitHubs_ETag()
    {
        using var factory = Factory();
        _github.Sends(FakeGitHub.RecordedRelease());

        await RunJobAsync(factory);

        var release = Assert.Single(await ReleasesAsync(factory));
        Assert.Equal("2.2.0", release.Version);
        Assert.Equal("v2.2.0", release.TagName);
        Assert.Equal(_now, release.FetchedAt);
        Assert.Equal(FakeGitHub.ETag, release.GitHubETag);
        Assert.Equal(7, release.Assets.Count);
        var installer = Assert.Single(release.Assets, a => a.Kind == ReleaseKind.Nsis);
        Assert.Equal("9de6dc34acae92ac25fcc9099afb411190566f7f5a5734990b13ba88ca4fd879", installer.Sha256);

        var request = Assert.Single(_github.Requests);
        Assert.Equal(HttpMethod.Get, request.Method);
        Assert.Equal("https://api.github.com/repos/SmartClouds/Runova/releases/latest", request.RequestUri?.ToString());
        Assert.Equal("application/vnd.github+json", Assert.Single(request.Headers.Accept).MediaType);
        Assert.Equal(["2022-11-28"], request.Headers.GetValues("X-GitHub-Api-Version"));
        Assert.NotEmpty(request.Headers.UserAgent);
        Assert.Empty(request.Headers.IfNoneMatch);
        Assert.Null(request.Headers.Authorization);
    }

    [Fact]
    public async Task With_a_token_configured_the_request_carries_it()
    {
        using var factory = Factory(new Dictionary<string, string> { ["GitHub:Token"] = "github-test-token" });
        _github.Sends(FakeGitHub.RecordedRelease());

        await RunJobAsync(factory);

        var request = Assert.Single(_github.Requests);
        Assert.Equal("Bearer", request.Headers.Authorization?.Scheme);
        Assert.Equal("github-test-token", request.Headers.Authorization?.Parameter);
    }

    [Fact]
    public async Task A_304_from_GitHub_leaves_the_stored_release_unchanged_and_writes_nothing()
    {
        using var factory = Factory();
        _github.Sends(FakeGitHub.RecordedRelease());
        await RunJobAsync(factory);
        var before = Assert.Single(await ReleasesAsync(factory));

        _time.Advance(TimeSpan.FromMinutes(15));
        _github.SendsNotModifiedFor(FakeGitHub.ETag);
        var writesBefore = _writes.Count;
        await RunJobAsync(factory);

        Assert.Equal(writesBefore, _writes.Count);
        Assert.Equal(2, _github.Requests.Count);
        Assert.Equal(FakeGitHub.ETag, Assert.Single(_github.Requests[1].Headers.IfNoneMatch).ToString());
        var after = Assert.Single(await ReleasesAsync(factory));
        Assert.Equal(before.RowVersion, after.RowVersion);
        Assert.Equal(_now, after.FetchedAt);
        Assert.Equal(FakeGitHub.ETag, after.GitHubETag);
    }

    [Fact]
    public async Task A_new_200_for_the_same_tag_updates_its_row_and_a_new_tag_becomes_the_latest()
    {
        using var factory = Factory();
        _github.Sends(FakeGitHub.RecordedRelease());
        await RunJobAsync(factory);

        // The same release once more files were uploaded to it.
        _time.Advance(TimeSpan.FromMinutes(15));
        _github.Sends(
            FakeGitHub.RecordedRelease().Replace("Runova-2.2.0-amd64.deb", "Runova-2.2.0-arm64.deb", StringComparison.Ordinal),
            "W/\"second\"");
        await RunJobAsync(factory);

        var updated = Assert.Single(await ReleasesAsync(factory));
        Assert.Equal(_now.AddMinutes(15), updated.FetchedAt);
        Assert.Equal("W/\"second\"", updated.GitHubETag);
        Assert.Contains(updated.Assets, a => a.Name == "Runova-2.2.0-arm64.deb");
        Assert.DoesNotContain(updated.Assets, a => a.Name == "Runova-2.2.0-amd64.deb");

        _time.Advance(TimeSpan.FromMinutes(15));
        _github.Sends(FakeGitHub.RecordedRelease().Replace("2.2.0", "2.3.0", StringComparison.Ordinal), "W/\"third\"");
        await RunJobAsync(factory);

        var releases = await ReleasesAsync(factory);
        Assert.Equal(["2.2.0", "2.3.0"], releases.Select(r => r.Version));
        Assert.Equal("W/\"third\"", releases[1].GitHubETag);
        Assert.Equal(7, releases[1].Assets.Count);
        Assert.Equal("W/\"second\"", Assert.Single(_github.Requests[2].Headers.IfNoneMatch).ToString());
    }

    private WebsiteApiFactory Factory(IReadOnlyDictionary<string, string>? settings = null) =>
        new(_database, time: _time, settings: settings, services: services =>
        {
            _github.Register(services);
            _writes.Register(services);
        });

    internal static async Task RunJobAsync(WebsiteApiFactory factory)
    {
        using var scope = factory.Services.CreateScope();
        await scope.ServiceProvider.GetRequiredService<ReleasesSyncJob>().RunAsync(TestContext.Current.CancellationToken);
    }

    private static async Task<List<Release>> ReleasesAsync(WebsiteApiFactory factory)
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        return await db.Releases.AsNoTracking().OrderBy(r => r.FetchedAt).ToListAsync(TestContext.Current.CancellationToken);
    }
}
