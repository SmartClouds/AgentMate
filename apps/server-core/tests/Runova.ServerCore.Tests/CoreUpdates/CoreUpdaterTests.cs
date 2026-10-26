using System.Net;
using System.Runtime.InteropServices;
using Microsoft.Extensions.Time.Testing;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Updates;

namespace Runova.ServerCore.Tests.CoreUpdates;

/// <summary>
/// The core updating itself: the request must name this server's build, whatever arrives (from
/// GitHub or the app) must be the release byte for byte before anything is unpacked, a download
/// that fails is an outcome the app can act on, and one update runs at a time.
/// </summary>
public sealed class CoreUpdaterTests : IDisposable
{
    private readonly FakeCoreInstallation _installation = new();
    private readonly FakeGitHub _github = new();
    private readonly FakeTimeProvider _clock = new(DateTimeOffset.UtcNow);

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private CoreUpdater Updater() => new(_installation, new FakeHttpClients(_github), _clock);

    public void Dispose()
    {
        _installation.Dispose();
        _github.Dispose();
    }

    [Fact]
    public async Task A_release_from_github_that_matches_is_switched_to()
    {
        var release = FakeRelease.Create();
        _github.Serve(release.Content);

        var result = await Updater().DownloadAsync(release.Request, Cancel);

        Assert.Equal(CoreUpdateOutcome.Switching, result.Outcome);
        var (directory, version, content) = Assert.Single(_installation.Switches);
        Assert.Equal($"/opt/runova-core/releases/1.72.0-{release.Request.Sha256[..12]}", directory);
        Assert.Equal("1.72.0", version);
        Assert.Equal(release.Content, content);
    }

    [Fact]
    public async Task A_download_github_refuses_is_an_outcome_and_leaves_nothing_behind()
    {
        var release = FakeRelease.Create();
        _github.Respond = _ => new HttpResponseMessage(HttpStatusCode.NotFound) { ReasonPhrase = "Not Found" };

        var result = await Updater().DownloadAsync(release.Request, Cancel);

        Assert.Equal(CoreUpdateOutcome.DownloadFailed, result.Outcome);
        Assert.Contains("404", result.Problem, StringComparison.Ordinal);
        Assert.Empty(_installation.Switches);
        Assert.False(Directory.Exists(_installation.StagingDirectory));
    }

    [Fact]
    public async Task No_route_to_github_is_an_outcome_too()
    {
        _github.Respond = _ => throw new HttpRequestException("Name or service not known (github.com:443)");

        var result = await Updater().DownloadAsync(FakeRelease.Create().Request, Cancel);

        Assert.Equal(CoreUpdateOutcome.DownloadFailed, result.Outcome);
        Assert.Contains("github.com", result.Problem, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_download_that_is_not_the_release_is_not_used()
    {
        var release = FakeRelease.Create();
        var tampered = (byte[])release.Content.Clone();
        tampered[1000] ^= 0xff;
        _github.Serve(tampered);

        var result = await Updater().DownloadAsync(release.Request, Cancel);

        Assert.Equal(CoreUpdateOutcome.DownloadFailed, result.Outcome);
        Assert.Contains("checksum", result.Problem, StringComparison.Ordinal);
        Assert.Empty(_installation.Switches);
        Assert.False(Directory.Exists(_installation.StagingDirectory));
    }

    [Fact]
    public async Task A_download_larger_than_the_release_is_cut_off()
    {
        var release = FakeRelease.Create();
        _github.Serve([.. release.Content, .. new byte[10]]);

        var result = await Updater().DownloadAsync(release.Request, Cancel);

        Assert.Equal(CoreUpdateOutcome.DownloadFailed, result.Outcome);
        Assert.Contains("larger", result.Problem, StringComparison.Ordinal);
    }

    [Fact]
    public async Task An_upload_that_matches_is_switched_to_and_one_that_does_not_is_refused()
    {
        var release = FakeRelease.Create(withUrl: false);
        var updater = Updater();

        var refused = await Assert.ThrowsAsync<CoreUpdateException>(() =>
            updater.ReceiveAsync(release.Request, new MemoryStream(release.Content[..^1]), Cancel));
        var result = await updater.ReceiveAsync(release.Request, new MemoryStream(release.Content), Cancel);

        Assert.Equal(CoreUpdateError.Mismatch, refused.Error);
        Assert.Equal(CoreUpdateOutcome.Switching, result.Outcome);
        Assert.Equal(release.Content, Assert.Single(_installation.Switches).Content);
        Assert.Equal(0, _github.Requests);
    }

    [Fact]
    public async Task A_core_the_app_did_not_install_says_so_without_fetching_anything()
    {
        _installation.CurrentRelease = null;
        var release = FakeRelease.Create();

        var result = await Updater().DownloadAsync(release.Request, Cancel);
        var upload = await Assert.ThrowsAsync<CoreUpdateException>(() =>
            Updater().ReceiveAsync(release.Request, new MemoryStream(release.Content), Cancel));

        Assert.Equal(CoreUpdateOutcome.Unsupported, result.Outcome);
        Assert.Contains("SSH", result.Problem, StringComparison.Ordinal);
        Assert.Equal(CoreUpdateError.Unsupported, upload.Error);
        Assert.Equal(0, _github.Requests);
    }

    [Fact]
    public async Task The_build_for_another_processor_is_refused()
    {
        var release = FakeRelease.Create(rid: "linux-arm64");

        var refused = await Assert.ThrowsAsync<CoreUpdateException>(() => Updater().DownloadAsync(release.Request, Cancel));

        Assert.Equal(CoreUpdateError.Invalid, refused.Error);
        Assert.Contains("linux-x64", refused.Message, StringComparison.Ordinal);
        Assert.Equal(0, _github.Requests);
    }

    [Fact]
    public async Task The_release_that_already_runs_is_refused()
    {
        var release = FakeRelease.Create();
        _installation.CurrentRelease = _installation.ReleaseDirectory(release.Request.Version, release.Request.Sha256);

        var refused = await Assert.ThrowsAsync<CoreUpdateException>(() => Updater().DownloadAsync(release.Request, Cancel));

        Assert.Contains("already runs", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Once_a_switch_is_scheduled_another_update_waits_for_it()
    {
        var release = FakeRelease.Create();
        _github.Serve(release.Content);
        var updater = Updater();
        await updater.DownloadAsync(release.Request, Cancel);

        var busy = await Assert.ThrowsAsync<CoreUpdateException>(() => updater.DownloadAsync(FakeRelease.Create("1.73.0").Request, Cancel));
        _clock.Advance(CoreUpdater.SwitchGrace);
        var later = FakeRelease.Create("1.73.0");
        _github.Serve(later.Content);
        var result = await updater.DownloadAsync(later.Request, Cancel);

        Assert.Equal(CoreUpdateError.Busy, busy.Error);
        Assert.Equal(CoreUpdateOutcome.Switching, result.Outcome);
    }

    [Fact]
    public async Task A_failed_unpack_clears_the_staging_folder_and_frees_the_updater()
    {
        var release = FakeRelease.Create();
        _github.Serve(release.Content);
        _installation.Fail = new CoreUpdateException(CoreUpdateError.Failed, "Unpacking the release failed: tar: unexpected end of file");
        var updater = Updater();

        var failed = await Assert.ThrowsAsync<CoreUpdateException>(() => updater.DownloadAsync(release.Request, Cancel));
        _installation.Fail = null;
        var retried = await updater.DownloadAsync(release.Request, Cancel);

        Assert.Equal(CoreUpdateError.Failed, failed.Error);
        Assert.Equal(CoreUpdateOutcome.Switching, retried.Outcome);
    }

    [Theory]
    [InlineData(true, Architecture.X64, "linux-x64")]
    [InlineData(true, Architecture.Arm64, "linux-arm64")]
    [InlineData(true, Architecture.Arm, null)]
    [InlineData(false, Architecture.X64, null)]
    public void The_build_follows_the_processor(bool linux, Architecture architecture, string? rid) =>
        Assert.Equal(rid, SystemdCoreInstallation.RidOf(linux, architecture));
}
