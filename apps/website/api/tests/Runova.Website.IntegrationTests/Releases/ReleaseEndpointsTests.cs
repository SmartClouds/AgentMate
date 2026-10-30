using System.Net;
using System.Text.Json;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Releases;

public sealed class ReleaseEndpointsTests(PostgresFixture postgres) : IAsyncLifetime
{
    private const string Latest = "/api/v1/releases/latest";
    private const string Assets = "/api/v1/releases/latest/assets";
    private const string Downloads = "/api/v1/releases/latest/downloads";
    private const string DownloadBase = "https://github.com/SmartClouds/Runova/releases/download/v2.2.0/";

    /// <summary>The desktop files of the recorded release; everything else in it must never come out.</summary>
    private static readonly string[] _desktopAssets =
    [
        "Runova-2.2.0-amd64.deb", "Runova-2.2.0-arm64-mac.zip", "Runova-2.2.0-arm64.dmg", "Runova-2.2.0-mac.zip",
        "Runova-2.2.0.AppImage", "Runova-2.2.0.dmg", "Runova-Setup-2.2.0.exe",
    ];

    private readonly FakeGitHub _github = new();
    private WebsiteApiFactory _factory = null!;
    private ApiClient _client = null!;

    // A database of its own: the latest release is whatever was fetched last, across the whole table.
    public async ValueTask InitializeAsync()
    {
        _factory = new(await postgres.CreateDatabaseAsync(), services: _github.Register);
        _client = _factory.CreateApiClient();
    }

    public ValueTask DisposeAsync()
    {
        _factory.Dispose();
        return ValueTask.CompletedTask;
    }

    [Theory]
    [InlineData(Latest)]
    [InlineData(Assets)]
    [InlineData(Downloads + "/windows")]
    public async Task Before_any_release_was_fetched_the_endpoints_answer_503(string path)
    {
        var response = await _client.GetAsync(path);

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.ServiceUnavailable, ProblemAssert.Type("unavailable"), path);
    }

    [Fact]
    public async Task The_latest_release_has_the_contract_shape_an_ETag_and_answers_304_to_it()
    {
        await SyncRecordedAsync();

        var response = await _client.GetAsync(Latest);

        var release = await ApiClient.ReadJsonAsync(response, HttpStatusCode.OK);
        Assert.Equal("public, max-age=300, stale-while-revalidate=600", response.Headers.CacheControl?.ToString());
        Assert.Equal("2.2.0", release.GetProperty("version").GetString());
        Assert.Equal("v2.2.0", release.GetProperty("tagName").GetString());
        Assert.Equal("Runova v2.2.0", release.GetProperty("name").GetString());
        Assert.Equal("2026-10-30T02:18:11.000Z", release.GetProperty("publishedAt").GetString());
        Assert.Equal("https://github.com/SmartClouds/Runova/releases/tag/v2.2.0", release.GetProperty("notesUrl").GetString());
        Assert.True(release.TryGetProperty("fetchedAt", out _));
        Assert.Equal(
            ["version", "tagName", "name", "publishedAt", "notesUrl", "fetchedAt", "assets"],
            release.EnumerateObject().Select(p => p.Name));
        var installer = Assert.Single(release.GetProperty("assets").EnumerateArray(), a => a.GetProperty("name").GetString() == "Runova-Setup-2.2.0.exe");
        Assert.Equal(
            """{"name":"Runova-Setup-2.2.0.exe","platform":"windows","arch":"x64","kind":"nsis","size":262371947,"sha256":"9de6dc34acae92ac25fcc9099afb411190566f7f5a5734990b13ba88ca4fd879","downloadUrl":"https://github.com/SmartClouds/Runova/releases/download/v2.2.0/Runova-Setup-2.2.0.exe"}""",
            installer.GetRawText());

        var etag = response.Headers.ETag;
        Assert.NotNull(etag);
        Assert.False(etag.IsWeak);
        using var request = new HttpRequestMessage(HttpMethod.Get, Latest);
        request.Headers.IfNoneMatch.Add(etag);
        var notModified = await _client.Http.SendAsync(request, TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.NotModified, notModified.StatusCode);
    }

    [Theory]
    [InlineData("", new[] { "Runova-2.2.0-amd64.deb", "Runova-2.2.0-arm64-mac.zip", "Runova-2.2.0-arm64.dmg", "Runova-2.2.0-mac.zip", "Runova-2.2.0.AppImage", "Runova-2.2.0.dmg", "Runova-Setup-2.2.0.exe" })]
    [InlineData("?platform=macos&arch=arm64", new[] { "Runova-2.2.0-arm64-mac.zip", "Runova-2.2.0-arm64.dmg" })]
    [InlineData("?platform=linux", new[] { "Runova-2.2.0-amd64.deb", "Runova-2.2.0.AppImage" })]
    [InlineData("?kind=dmg", new[] { "Runova-2.2.0-arm64.dmg", "Runova-2.2.0.dmg" })]
    [InlineData("?platform=windows&arch=arm64", new string[0])]
    public async Task Assets_filter_by_platform_arch_and_kind(string query, string[] expected)
    {
        await SyncRecordedAsync();

        var assets = await ApiClient.ReadJsonAsync(await _client.GetAsync(Assets + query), HttpStatusCode.OK);

        Assert.Equal(expected, assets.EnumerateArray().Select(a => a.GetProperty("name").GetString()).Order(StringComparer.Ordinal));
    }

    [Theory]
    [InlineData("?platform=android", "platform")]
    [InlineData("?arch=ia64", "arch")]
    [InlineData("?kind=apk", "kind")]
    [InlineData("?platform=Windows", "platform")]
    public async Task An_unknown_filter_value_is_a_400(string query, string field)
    {
        await SyncRecordedAsync();

        var problem = await ProblemAssert.IsProblemAsync(
            await _client.GetAsync(Assets + query), HttpStatusCode.BadRequest, ProblemAssert.Type("validation-failed"), Assets);

        Assert.Equal([field], problem.GetProperty("errors").EnumerateObject().Select(p => p.Name));
    }

    [Theory]
    [InlineData("/windows", "Runova-Setup-2.2.0.exe")]
    [InlineData("/macos?arch=arm64", "Runova-2.2.0-arm64.dmg")]
    [InlineData("/macos", "Runova-2.2.0-arm64.dmg")]
    [InlineData("/macos?arch=x64", "Runova-2.2.0.dmg")]
    [InlineData("/macos?kind=zip", "Runova-2.2.0-arm64-mac.zip")]
    [InlineData("/linux", "Runova-2.2.0.AppImage")]
    [InlineData("/linux?kind=deb", "Runova-2.2.0-amd64.deb")]
    public async Task A_download_redirects_to_the_best_asset(string path, string asset)
    {
        await SyncRecordedAsync();

        var response = await _client.GetAsync(Downloads + path);

        Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
        Assert.Equal(new Uri(DownloadBase + asset), response.Headers.Location);
    }

    [Theory]
    [InlineData("/android")]
    [InlineData("/Windows")]
    [InlineData("/linux?arch=arm64")]
    [InlineData("/windows?kind=dmg")]
    [InlineData("/macos?arch=ia64")]
    public async Task An_unknown_platform_or_a_missing_asset_is_a_404(string path)
    {
        await SyncRecordedAsync();

        await ProblemAssert.IsProblemAsync(
            await _client.GetAsync(Downloads + path), HttpStatusCode.NotFound, ProblemAssert.Type("not-found"), Downloads + path.Split('?')[0]);
    }

    [Fact]
    public async Task No_file_that_is_not_the_desktop_app_is_ever_returned()
    {
        await SyncRecordedAsync();
        string?[] platforms = [null, "windows", "macos", "linux"];
        string?[] arches = [null, "x64", "arm64", "universal"];
        string?[] kinds = [null, "nsis", "dmg", "zip", "appimage", "deb"];

        var latest = await ApiClient.ReadJsonAsync(await _client.GetAsync(Latest), HttpStatusCode.OK);
        Assert.Equal(_desktopAssets, Names(latest.GetProperty("assets")).Order(StringComparer.Ordinal));
        foreach (var platform in platforms)
        {
            foreach (var arch in arches)
            {
                foreach (var kind in kinds)
                {
                    var query = Query(("platform", platform), ("arch", arch), ("kind", kind));
                    var assets = await ApiClient.ReadJsonAsync(await _client.GetAsync(Assets + query), HttpStatusCode.OK);
                    Assert.All(Names(assets), name => Assert.Contains(name, _desktopAssets));
                    if (platform is null)
                    {
                        continue;
                    }

                    var download = await _client.GetAsync($"{Downloads}/{platform}{Query(("arch", arch), ("kind", kind))}");
                    if (download.StatusCode == HttpStatusCode.Redirect)
                    {
                        Assert.Contains(download.Headers.Location!.ToString()[DownloadBase.Length..], _desktopAssets);
                    }
                    else
                    {
                        Assert.Equal(HttpStatusCode.NotFound, download.StatusCode);
                    }
                }
            }
        }
    }

    private async Task SyncRecordedAsync()
    {
        _github.Sends(FakeGitHub.RecordedRelease());
        await ReleasesSyncJobTests.RunJobAsync(_factory);
    }

    private static IEnumerable<string?> Names(JsonElement assets) => assets.EnumerateArray().Select(a => a.GetProperty("name").GetString());

    private static string Query(params (string Name, string? Value)[] parameters)
    {
        var set = parameters.Where(p => p.Value is not null).Select(p => $"{p.Name}={p.Value}").ToList();
        return set.Count == 0 ? "" : "?" + string.Join('&', set);
    }
}
