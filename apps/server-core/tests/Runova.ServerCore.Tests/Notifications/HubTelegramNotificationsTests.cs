using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Tests.Notifications;

/// <summary>
/// Telegram notifications through the hub: Admins read the status and send a test message, only an
/// Owner who stepped up changes the setup (what happens on the server leaves it), every change is
/// audited without the token, and the token never comes back over the wire.
/// </summary>
public sealed class HubTelegramNotificationsTests
{
    private const string Token = TelegramSettingsTests.Token;

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
            .Where(e => e.Action.StartsWith("telegram."))
            .OrderBy(e => e.Id)
            .Select(e => e.Action + ":" + e.Result)
            .ToListAsync(Cancel);
    }

    private static TelegramNotificationsRequest Request(string? token = Token, string? chat = "-1001234567890") =>
        new(true, token, chat, "web-1", [AlertKind.BackupFailed, AlertKind.ContainerCrashLoop], true);

    private static Task<TelegramNotificationsSaveResult> SaveAsync(HubConnection hub, TelegramNotificationsRequest request) =>
        hub.InvokeAsync<TelegramNotificationsSaveResult>(nameof(ICoreHub.SaveTelegramNotifications), request, Cancel);

    private static Task<TelegramNotificationsStatus> GetAsync(HubConnection hub) =>
        hub.InvokeAsync<TelegramNotificationsStatus>(nameof(ICoreHub.GetTelegramNotifications), Cancel);

    private static Task<TelegramNotificationsStatus> RemoveAsync(HubConnection hub) =>
        hub.InvokeAsync<TelegramNotificationsStatus>(nameof(ICoreHub.RemoveTelegramNotifications), Cancel);

    private static Task<TelegramNotificationsTestResult> TestAsync(HubConnection hub) =>
        hub.InvokeAsync<TelegramNotificationsTestResult>(nameof(ICoreHub.SendTelegramNotificationTest), Cancel);

    [Fact]
    public async Task A_viewer_cannot_read_change_remove_or_test_it()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Viewer, fakeClock: false);
        await using var hub = await ConnectAsync(harness, stepUp: true);

        var refusals = new[]
        {
            await Assert.ThrowsAsync<HubException>(() => GetAsync(hub)),
            await Assert.ThrowsAsync<HubException>(() => SaveAsync(hub, Request())),
            await Assert.ThrowsAsync<HubException>(() => RemoveAsync(hub)),
            await Assert.ThrowsAsync<HubException>(() => TestAsync(hub)),
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
        var refusedRemove = await Assert.ThrowsAsync<HubException>(() => RemoveAsync(hub));
        var test = await TestAsync(hub);

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
        var refusedRemove = await Assert.ThrowsAsync<HubException>(() => RemoveAsync(hub));

        Assert.Contains("unauthorized", refusedSave.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("unauthorized", refusedRemove.Message, StringComparison.OrdinalIgnoreCase);
        Assert.False((await GetAsync(hub)).Configured);
    }

    [Fact]
    public async Task An_owner_sets_it_up_tests_it_and_removes_it_and_each_step_is_audited()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Owner, fakeClock: false);
        await using var hub = await ConnectAsync(harness, stepUp: true);
        var telegram = harness.Services.GetRequiredService<FakeTelegramApi>().Handler;

        var saved = await SaveAsync(hub, Request());
        var read = await GetAsync(hub);
        var test = await TestAsync(hub);
        var removed = await RemoveAsync(hub);

        Assert.Empty(saved.Problems);
        Assert.True(saved.Status!.Configured);
        Assert.Equal("-1001234567890", read.ChatId);
        Assert.Equal("web-1", read.ServerName);
        Assert.Equal([AlertKind.BackupFailed, AlertKind.ContainerCrashLoop], read.Kinds);
        Assert.Equal("maria", read.ChangedBy);
        Assert.True(test.Delivered);
        Assert.Equal($"/bot{Token}/sendMessage", Assert.Single(telegram.Requests).Uri.AbsolutePath);
        Assert.False(removed.Configured);
        Assert.Equal(
            ["telegram.save:success", "telegram.test:success", "telegram.remove:success"],
            await AuditAsync(harness));
    }

    [Fact]
    public async Task The_token_never_comes_back_over_the_wire_or_into_the_audit_trail()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Owner, fakeClock: false);
        await using var hub = await ConnectAsync(harness, stepUp: true);
        var secret = Token.Split(':')[1];

        var saved = await SaveAsync(hub, Request());
        var read = await GetAsync(hub);

        Assert.DoesNotContain(secret, JsonSerializer.Serialize(saved, CoreJson.Options), StringComparison.Ordinal);
        Assert.DoesNotContain(secret, JsonSerializer.Serialize(read, CoreJson.Options), StringComparison.Ordinal);
        await using var scope = harness.Services.CreateAsyncScope();
        var parameters = await scope.ServiceProvider.GetRequiredService<CoreDbContext>().AuditEvents
            .Where(e => e.Action.StartsWith("telegram."))
            .Select(e => e.Parameters)
            .ToListAsync(Cancel);
        Assert.NotEmpty(parameters);
        Assert.All(parameters, text => Assert.DoesNotContain(secret, text ?? string.Empty, StringComparison.Ordinal));
        Assert.Contains(parameters, text => text is not null && text.Contains("-1001234567890", StringComparison.Ordinal));
        Assert.DoesNotContain(secret, Request().ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_bad_request_comes_back_as_problems_stores_nothing_and_is_audited_as_denied()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Owner, fakeClock: false);
        await using var hub = await ConnectAsync(harness, stepUp: true);

        var saved = await SaveAsync(hub, Request(chat: "somebody"));

        Assert.NotEmpty(saved.Problems);
        Assert.Null(saved.Status);
        Assert.False((await GetAsync(hub)).Configured);
        Assert.Equal(["telegram.save:denied"], await AuditAsync(harness));
    }

    [Fact]
    public async Task A_test_that_telegram_refuses_says_why_and_is_still_audited()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Owner, fakeClock: false);
        await using var hub = await ConnectAsync(harness, stepUp: true);
        harness.Services.GetRequiredService<FakeTelegramApi>().Handler.Respond =
            _ => FakeTelegram.Error(HttpStatusCode.BadRequest, "Bad Request: chat not found");
        await SaveAsync(hub, Request());

        var test = await TestAsync(hub);

        Assert.False(test.Delivered);
        Assert.Contains("cannot find that chat", test.Message, StringComparison.Ordinal);
        Assert.Equal(["telegram.save:success", "telegram.test:failed"], await AuditAsync(harness));
    }
}
