using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Tests.ErrorReporting;

/// <summary>
/// Error reporting through the hub: Admins read the status and send a test event, only an Owner who
/// stepped up changes the setup (logs leave the machine), every change is audited without the key,
/// and the key never comes back over the wire.
/// </summary>
public sealed class HubErrorReportingTests
{
    private const string Key = "d4e5f60718293a4b5c6d7e8f90a1b2c3";

    private const string Dsn = $"https://{Key}@o1.ingest.sentry.io/42";

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private static async Task<HubConnection> ConnectAsync(AuthHarness harness, bool stepUp)
    {
        var signedIn = await harness.SignInAsync();
        var hub = harness.Hub(signedIn.AccessToken);
        await hub.StartAsync(Cancel);
        if (stepUp)
        {
            await hub.InvokeAsync<StepUpResponse>(nameof(ICoreHub.StepUp), new StepUpRequest(AuthHarness.Password), Cancel);
        }

        return hub;
    }

    private static async Task<List<string>> AuditAsync(AuthHarness harness)
    {
        await using var scope = harness.Services.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<CoreDbContext>().AuditEvents
            .Where(e => e.Action.StartsWith("errorReporting."))
            .OrderBy(e => e.Id)
            .Select(e => e.Action + ":" + e.Result)
            .ToListAsync(Cancel);
    }

    private static ErrorReportingRequest Request(string? dsn = Dsn, bool enabled = true, string? level = "warning") =>
        new(dsn, enabled, "staging", "web-1", level);

    private static Task<ErrorReportingSaveResult> SaveAsync(HubConnection hub, ErrorReportingRequest request) =>
        hub.InvokeAsync<ErrorReportingSaveResult>(nameof(ICoreHub.SaveErrorReporting), request, Cancel);

    private static Task<ErrorReportingStatus> GetAsync(HubConnection hub) =>
        hub.InvokeAsync<ErrorReportingStatus>(nameof(ICoreHub.GetErrorReporting), Cancel);

    [Fact]
    public async Task A_viewer_cannot_read_change_remove_or_test_it()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Viewer, fakeClock: false);
        await using var hub = await ConnectAsync(harness, stepUp: true);

        var refusals = new[]
        {
            await Assert.ThrowsAsync<HubException>(() => GetAsync(hub)),
            await Assert.ThrowsAsync<HubException>(() => SaveAsync(hub, Request())),
            await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync<ErrorReportingStatus>(nameof(ICoreHub.RemoveErrorReporting), Cancel)),
            await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync<ErrorReportingTestResult>(nameof(ICoreHub.SendErrorReportingTest), Cancel)),
        };

        Assert.All(refusals, refused => Assert.Contains("unauthorized", refused.Message, StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task An_admin_reads_the_status_and_tests_but_cannot_change_the_setup()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Admin, fakeClock: false);
        await using var hub = await ConnectAsync(harness, stepUp: true);

        var status = await GetAsync(hub);
        var refusedSave = await Assert.ThrowsAsync<HubException>(() => SaveAsync(hub, Request()));
        var refusedRemove = await Assert.ThrowsAsync<HubException>(() =>
            hub.InvokeAsync<ErrorReportingStatus>(nameof(ICoreHub.RemoveErrorReporting), Cancel));
        var test = await hub.InvokeAsync<ErrorReportingTestResult>(nameof(ICoreHub.SendErrorReportingTest), Cancel);

        Assert.False(status.Configured);
        Assert.Contains("unauthorized", refusedSave.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("unauthorized", refusedRemove.Message, StringComparison.OrdinalIgnoreCase);
        Assert.False(test.Delivered);
    }

    [Fact]
    public async Task An_owner_needs_a_step_up_to_change_or_remove_it()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Owner, fakeClock: false);
        await using var hub = await ConnectAsync(harness, stepUp: false);

        var refusedSave = await Assert.ThrowsAsync<HubException>(() => SaveAsync(hub, Request()));
        var refusedRemove = await Assert.ThrowsAsync<HubException>(() =>
            hub.InvokeAsync<ErrorReportingStatus>(nameof(ICoreHub.RemoveErrorReporting), Cancel));

        Assert.Contains("unauthorized", refusedSave.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("unauthorized", refusedRemove.Message, StringComparison.OrdinalIgnoreCase);
        Assert.False((await GetAsync(hub)).Configured);
    }

    [Fact]
    public async Task An_owner_sets_it_up_tests_it_and_removes_it_and_each_step_is_audited()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Owner, fakeClock: false);
        await using var hub = await ConnectAsync(harness, stepUp: true);
        var ingest = harness.Services.GetRequiredService<FakeIngest>();

        var saved = await SaveAsync(hub, Request());
        var read = await GetAsync(hub);
        var test = await hub.InvokeAsync<ErrorReportingTestResult>(nameof(ICoreHub.SendErrorReportingTest), Cancel);
        var removed = await hub.InvokeAsync<ErrorReportingStatus>(nameof(ICoreHub.RemoveErrorReporting), Cancel);

        Assert.Empty(saved.Problems);
        Assert.True(saved.Status!.Configured);
        Assert.Equal("o1.ingest.sentry.io", read.Host);
        Assert.Equal("42", read.ProjectId);
        Assert.Equal("maria", read.ChangedBy);
        Assert.True(test.Delivered);
        Assert.Equal(Dsn.Replace(Key + "@", string.Empty, StringComparison.Ordinal), $"https://{read.Host}/{read.ProjectId}");
        Assert.Contains(ingest.Requests, request => request.Uri.AbsolutePath == "/api/42/integration/otlp/v1/logs");
        Assert.False(removed.Configured);
        Assert.Equal(
            ["errorReporting.save:success", "errorReporting.test:success", "errorReporting.remove:success"],
            await AuditAsync(harness));
    }

    [Fact]
    public async Task The_key_never_comes_back_over_the_wire_or_into_the_audit_trail()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Owner, fakeClock: false);
        await using var hub = await ConnectAsync(harness, stepUp: true);

        var saved = await SaveAsync(hub, Request());
        var read = await GetAsync(hub);

        Assert.DoesNotContain(Key, JsonSerializer.Serialize(saved, CoreJson.Options), StringComparison.Ordinal);
        Assert.DoesNotContain(Key, JsonSerializer.Serialize(read, CoreJson.Options), StringComparison.Ordinal);
        await using var scope = harness.Services.CreateAsyncScope();
        var parameters = await scope.ServiceProvider.GetRequiredService<CoreDbContext>().AuditEvents
            .Where(e => e.Action.StartsWith("errorReporting."))
            .Select(e => e.Parameters)
            .ToListAsync(Cancel);
        Assert.NotEmpty(parameters);
        Assert.All(parameters, text => Assert.DoesNotContain(Key, text ?? string.Empty, StringComparison.Ordinal));
        Assert.Contains(parameters, text => text is not null && text.Contains("o1.ingest.sentry.io", StringComparison.Ordinal));
        Assert.DoesNotContain(Key, new ErrorReportingRequest(Dsn, true, null, null, null).ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_bad_request_comes_back_as_problems_stores_nothing_and_is_audited_as_denied()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Owner, fakeClock: false);
        await using var hub = await ConnectAsync(harness, stepUp: true);

        var saved = await SaveAsync(hub, Request(dsn: "https://nope/abc"));

        Assert.NotEmpty(saved.Problems);
        Assert.Null(saved.Status);
        Assert.False((await GetAsync(hub)).Configured);
        Assert.Equal(["errorReporting.save:denied"], await AuditAsync(harness));
    }

    [Fact]
    public async Task Changing_only_the_level_keeps_the_dsn()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Owner, fakeClock: false);
        await using var hub = await ConnectAsync(harness, stepUp: true);
        await SaveAsync(hub, Request());

        var saved = await SaveAsync(hub, Request(dsn: null, level: "error"));

        Assert.Empty(saved.Problems);
        Assert.Equal("error", saved.Status!.MinLevel);
        Assert.Equal("42", saved.Status.ProjectId);
    }

    [Fact]
    public async Task A_test_that_sentry_refuses_says_why_and_is_still_audited()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Owner, fakeClock: false);
        await using var hub = await ConnectAsync(harness, stepUp: true);
        harness.Services.GetRequiredService<FakeIngest>().Respond = _ => new HttpResponseMessage(HttpStatusCode.NotFound);
        await SaveAsync(hub, Request());

        var test = await hub.InvokeAsync<ErrorReportingTestResult>(nameof(ICoreHub.SendErrorReportingTest), Cancel);

        Assert.False(test.Delivered);
        Assert.Equal(404, test.HttpStatus);
        Assert.Contains("no project", test.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(["errorReporting.save:success", "errorReporting.test:failed"], await AuditAsync(harness));
    }
}
