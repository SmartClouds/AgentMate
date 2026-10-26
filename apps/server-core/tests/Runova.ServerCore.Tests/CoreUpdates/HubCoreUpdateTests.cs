using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Endpoints;
using Runova.ServerCore.Security;
using Runova.ServerCore.Updates;

namespace Runova.ServerCore.Tests.CoreUpdates;

/// <summary>
/// A core update through the hub (the core downloads) and the REST upload the app falls back on:
/// both are an Owner's, with a step-up, and both land in the audit trail.
/// </summary>
public sealed class HubCoreUpdateTests
{
    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private static Task<AuthHarness> CreateAsync(string role, FakeCoreInstallation installation, FakeGitHub github) =>
        AuthHarness.CreateAsync(role, fakeClock: false, (services, _) => services.AddSingleton(provider =>
            new CoreUpdater(installation, new FakeHttpClients(github), provider.GetRequiredService<TimeProvider>())));

    private static async Task<(HubConnection Hub, string Token)> ConnectAsync(AuthHarness harness, bool stepUp)
    {
        var signedIn = await harness.SignInAsync();
        var hub = harness.Hub(signedIn.AccessToken);
        await hub.StartAsync(Cancel);
        if (stepUp)
        {
            await hub.InvokeAsync<StepUpResponse>(nameof(ICoreHub.StepUp), new StepUpRequest(AuthHarness.Password), Cancel);
        }

        return (hub, signedIn.AccessToken);
    }

    private static Task<CoreUpdateResult> UpdateAsync(HubConnection hub, CoreUpdateRequest request) =>
        hub.InvokeAsync<CoreUpdateResult>(nameof(ICoreHub.UpdateCore), request, Cancel);

    private static Task<HttpResponseMessage> UploadAsync(AuthHarness harness, string token, FakeRelease release, byte[]? body = null)
    {
        var message = new HttpRequestMessage(HttpMethod.Put, CoreUpdateEndpoints.Path) { Content = new ByteArrayContent(body ?? release.Content) };
        message.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        message.Headers.Add(CoreUpdateEndpoints.VersionHeader, release.Request.Version);
        message.Headers.Add(CoreUpdateEndpoints.FileHeader, release.Request.File);
        message.Headers.Add(CoreUpdateEndpoints.Sha256Header, release.Request.Sha256);
        return harness.Client.SendAsync(message, Cancel);
    }

    private static async Task<List<string>> AuditAsync(AuthHarness harness)
    {
        await using var scope = harness.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<CoreDbContext>().AuditEvents
            .Where(e => e.Action == "core.update")
            .OrderBy(e => e.Id)
            .Select(e => e.Result)
            .ToListAsync(Cancel);
    }

    [Fact]
    public async Task An_admin_cannot_update_the_core_either_way()
    {
        using var installation = new FakeCoreInstallation();
        using var github = new FakeGitHub();
        await using var harness = await CreateAsync(CoreRoles.Admin, installation, github);
        var (hub, token) = await ConnectAsync(harness, stepUp: true);
        await using var _ = hub;
        var release = FakeRelease.Create();

        var refused = await Assert.ThrowsAsync<HubException>(() => UpdateAsync(hub, release.Request));
        var upload = await UploadAsync(harness, token, release);

        Assert.Contains("unauthorized", refused.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(HttpStatusCode.Forbidden, upload.StatusCode);
        Assert.Equal(0, github.Requests);
        Assert.Empty(installation.Switches);
    }

    [Fact]
    public async Task An_owner_needs_a_step_up()
    {
        using var installation = new FakeCoreInstallation();
        using var github = new FakeGitHub();
        await using var harness = await CreateAsync(CoreRoles.Owner, installation, github);
        var (hub, token) = await ConnectAsync(harness, stepUp: false);
        await using var _ = hub;
        var release = FakeRelease.Create();

        var refused = await Assert.ThrowsAsync<HubException>(() => UpdateAsync(hub, release.Request));
        var upload = await UploadAsync(harness, token, release);

        Assert.Contains("unauthorized", refused.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(HttpStatusCode.Forbidden, upload.StatusCode);
        Assert.Empty(installation.Switches);
    }

    [Fact]
    public async Task The_core_downloads_the_release_itself_when_it_can()
    {
        using var installation = new FakeCoreInstallation();
        using var github = new FakeGitHub();
        await using var harness = await CreateAsync(CoreRoles.Owner, installation, github);
        var (hub, _) = await ConnectAsync(harness, stepUp: true);
        await using var connection = hub;
        var release = FakeRelease.Create();
        github.Serve(release.Content);

        var result = await UpdateAsync(hub, release.Request);

        Assert.Equal(CoreUpdateOutcome.Switching, result.Outcome);
        Assert.Equal(release.Content, Assert.Single(installation.Switches).Content);
        Assert.Equal(["success"], await AuditAsync(harness));
    }

    [Fact]
    public async Task When_the_download_fails_the_app_uploads_the_release()
    {
        using var installation = new FakeCoreInstallation();
        using var github = new FakeGitHub();
        await using var harness = await CreateAsync(CoreRoles.Owner, installation, github);
        var (hub, token) = await ConnectAsync(harness, stepUp: true);
        await using var connection = hub;
        var release = FakeRelease.Create();

        var download = await UpdateAsync(hub, release.Request);
        var tampered = await UploadAsync(harness, token, release, [.. release.Content[..^1], 0]);
        var upload = await UploadAsync(harness, token, release);
        var result = await upload.Content.ReadFromJsonAsync<CoreUpdateResult>(CoreJson.Options, Cancel);

        Assert.Equal(CoreUpdateOutcome.DownloadFailed, download.Outcome);
        Assert.Equal(HttpStatusCode.UnprocessableEntity, tampered.StatusCode);
        Assert.Contains("\"mismatch\"", await tampered.Content.ReadAsStringAsync(Cancel), StringComparison.Ordinal);
        Assert.Equal(HttpStatusCode.OK, upload.StatusCode);
        Assert.Equal(CoreUpdateOutcome.Switching, result!.Outcome);
        Assert.Equal(release.Content, Assert.Single(installation.Switches).Content);
        Assert.Equal(["failed", "failed", "success"], await AuditAsync(harness));
    }

    [Fact]
    public async Task A_bad_request_is_refused_with_its_reason()
    {
        using var installation = new FakeCoreInstallation();
        using var github = new FakeGitHub();
        await using var harness = await CreateAsync(CoreRoles.Owner, installation, github);
        var (hub, _) = await ConnectAsync(harness, stepUp: true);
        await using var connection = hub;

        var refused = await Assert.ThrowsAsync<HubException>(() =>
            UpdateAsync(hub, FakeRelease.Create().Request with { DownloadUrl = "https://example.com/runova-core-1.72.0-linux-x64.tar.gz" }));

        Assert.Contains("GitHub", refused.Message, StringComparison.Ordinal);
        Assert.Equal(["denied"], await AuditAsync(harness));
    }
}
