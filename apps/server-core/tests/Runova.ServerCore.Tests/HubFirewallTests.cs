using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Security;
using static Runova.ServerCore.Tests.FirewallTestData;

namespace Runova.ServerCore.Tests;

/// <summary>
/// The firewall through a real hub connection: every role reads it, Admins change it, turning it
/// on or off and overriding the lockout guard also need a step-up, a confirmation has to come over
/// a new connection, and every change and refusal is on the audit trail.
/// </summary>
public sealed class HubFirewallTests
{
    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private static async Task<HubConnection> ConnectAsync(AuthHarness harness)
    {
        var signedIn = await harness.SignInAsync();
        var hub = harness.Hub(signedIn.AccessToken);
        await hub.StartAsync(Cancel);
        return hub;
    }

    private static Task<StepUpResponse> StepUpAsync(HubConnection hub) =>
        hub.InvokeAsync<StepUpResponse>(nameof(ICoreHub.StepUp), new StepUpRequest(AuthHarness.Password), Cancel);

    private static async Task<List<string>> AuditAsync(AuthHarness harness)
    {
        await using var scope = harness.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<CoreDbContext>();
        return await db.AuditEvents.OrderBy(e => e.Id).Select(e => e.Action + ":" + e.Result).ToListAsync(Cancel);
    }

    private static IReadOnlyList<string> Mutations(AuthHarness harness) => harness.Services.GetRequiredService<MutationLog>().Entries;

    private static FirewallChangeRequest Open(int port) => new([Add(Tcp(port))]);

    [Fact]
    public async Task A_viewer_reads_the_firewall_and_cannot_change_it()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Viewer);
        await using var hub = await ConnectAsync(harness);

        var status = await hub.InvokeAsync<FirewallStatus>(nameof(ICoreHub.GetFirewallStatus), Cancel);
        var presets = await hub.InvokeAsync<FirewallPreset[]>(nameof(ICoreHub.GetFirewallPresets), Cancel);
        var history = await hub.InvokeAsync<FirewallChangeSetInfo[]>(nameof(ICoreHub.ListFirewallChangeSets), new FirewallChangeSetQuery(), Cancel);
        var exposure = await hub.InvokeAsync<ExposureInventory>(nameof(ICoreHub.GetExposure), Cancel);
        var refused = await Assert.ThrowsAsync<HubException>(() =>
            hub.InvokeAsync<FirewallChangeSetInfo>(nameof(ICoreHub.ApplyFirewallChanges), Open(80), Cancel));

        Assert.Equal(FirewallBackendKind.Ufw, status.Backend);
        Assert.True(status.Active);
        Assert.Equal("Allow 22/tcp from anywhere", Assert.Single(status.Rules).Description);
        Assert.Equal([22], status.Ssh.Ports);
        Assert.Equal(60, status.ConfirmWithinSeconds);
        Assert.Equal(["ssh", "http", "https", "mysql", "postgresql", "redis", "mongodb"], presets.Select(preset => preset.Id));
        Assert.Empty(history);
        Assert.Single(exposure.Sockets);
        Assert.Contains("unauthorized", refused.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Empty(Mutations(harness));
    }

    [Fact]
    public async Task An_operator_cannot_change_the_firewall()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Operator);
        await using var hub = await ConnectAsync(harness);

        var refused = await Assert.ThrowsAsync<HubException>(() =>
            hub.InvokeAsync<FirewallChangePreview>(nameof(ICoreHub.PreviewFirewallChanges), Open(80), Cancel));

        Assert.Contains("unauthorized", refused.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task An_admin_applies_a_change_that_waits_for_confirmation_on_the_audit_trail()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Admin);
        await using var hub = await ConnectAsync(harness);

        var preview = await hub.InvokeAsync<FirewallChangePreview>(nameof(ICoreHub.PreviewFirewallChanges), Open(80), Cancel);
        var change = await hub.InvokeAsync<FirewallChangeSetInfo>(nameof(ICoreHub.ApplyFirewallChanges), Open(80), Cancel);
        var status = await hub.InvokeAsync<FirewallStatus>(nameof(ICoreHub.GetFirewallStatus), Cancel);

        Assert.False(preview.Guard.Blocked);
        Assert.False(preview.NeedsStepUp);
        Assert.Equal(["add Allow 80/tcp from anywhere"], preview.Commands);
        Assert.Equal(FirewallChangeState.AwaitingConfirmation, change.State);
        Assert.Equal("maria", change.RequestedBy);
        Assert.Equal(change.Id, status.Pending?.Id);
        Assert.Equal(["firewall.arm=60s", "firewall.apply=Allow 80/tcp from anywhere"], Mutations(harness));
        Assert.Contains("firewall.apply:success", await AuditAsync(harness));
    }

    [Theory]
    [InlineData(FirewallChangeKind.Enable)]
    [InlineData(FirewallChangeKind.Disable)]
    public async Task Turning_the_firewall_on_or_off_needs_a_step_up(FirewallChangeKind kind)
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Admin);
        var backend = harness.Services.GetRequiredService<FakeFirewallBackend>();
        backend.State = backend.State with { Active = kind == FirewallChangeKind.Disable };
        await using var hub = await ConnectAsync(harness);
        var request = new FirewallChangeRequest([new FirewallChange(kind)]);

        var refused = await Assert.ThrowsAsync<HubException>(() =>
            hub.InvokeAsync<FirewallChangeSetInfo>(nameof(ICoreHub.ApplyFirewallChanges), request, Cancel));
        await StepUpAsync(hub);
        var change = await hub.InvokeAsync<FirewallChangeSetInfo>(nameof(ICoreHub.ApplyFirewallChanges), request, Cancel);

        Assert.Contains("step-up", refused.Message, StringComparison.Ordinal);
        Assert.Equal(FirewallChangeState.AwaitingConfirmation, change.State);
        Assert.Equal(kind == FirewallChangeKind.Enable, backend.State.Active);
        Assert.Contains("firewall.apply:denied", await AuditAsync(harness));
    }

    [Fact]
    public async Task Overriding_the_lockout_guard_needs_the_phrase_and_a_step_up()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Admin);
        var backend = harness.Services.GetRequiredService<FakeFirewallBackend>();
        var ssh = backend.State.Rules.Single();
        await using var hub = await ConnectAsync(harness);
        var plain = new FirewallChangeRequest([Remove(ssh.Id)]);
        var overriding = plain with { OverrideConfirmation = "block ssh on port 22" };

        var preview = await hub.InvokeAsync<FirewallChangePreview>(nameof(ICoreHub.PreviewFirewallChanges), plain, Cancel);
        var withoutPhrase = await Assert.ThrowsAsync<HubException>(() =>
            hub.InvokeAsync<FirewallChangeSetInfo>(nameof(ICoreHub.ApplyFirewallChanges), plain, Cancel));
        var withoutStepUp = await Assert.ThrowsAsync<HubException>(() =>
            hub.InvokeAsync<FirewallChangeSetInfo>(nameof(ICoreHub.ApplyFirewallChanges), overriding, Cancel));
        Assert.Empty(Mutations(harness));
        await StepUpAsync(hub);
        var change = await hub.InvokeAsync<FirewallChangeSetInfo>(nameof(ICoreHub.ApplyFirewallChanges), overriding, Cancel);

        Assert.True(preview.Guard.Blocked);
        Assert.True(preview.NeedsStepUp);
        Assert.Equal("block ssh on port 22", preview.Guard.ConfirmationPhrase);
        Assert.Contains("would cut this computer off from SSH", withoutPhrase.Message, StringComparison.Ordinal);
        Assert.Contains("block ssh on port 22", withoutPhrase.Message, StringComparison.Ordinal);
        Assert.Contains("step-up", withoutStepUp.Message, StringComparison.Ordinal);
        Assert.True(change.GuardOverridden);
        Assert.Empty(backend.State.Rules);
        await using var scope = harness.Services.CreateAsyncScope();
        var parameters = await scope.ServiceProvider.GetRequiredService<CoreDbContext>().AuditEvents
            .Where(e => e.Action == "firewall.apply" && e.Result == "success")
            .Select(e => e.Parameters)
            .SingleAsync(Cancel);
        Assert.Contains("\"guardOverridden\":\"true\"", parameters, StringComparison.Ordinal);
        Assert.Contains("\"sshConnection\":\"203.0.113.50", parameters, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_change_is_confirmed_over_a_new_connection_and_not_over_the_one_that_made_it()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Admin);
        var signedIn = await harness.SignInAsync();
        await using var first = harness.Hub(signedIn.AccessToken);
        await first.StartAsync(Cancel);
        var change = await first.InvokeAsync<FirewallChangeSetInfo>(nameof(ICoreHub.ApplyFirewallChanges), Open(80), Cancel);

        var same = await Assert.ThrowsAsync<HubException>(() =>
            first.InvokeAsync<FirewallChangeSetInfo>(nameof(ICoreHub.ConfirmFirewallChanges), change.Id, Cancel));
        await using var fresh = harness.Hub(signedIn.AccessToken);
        await fresh.StartAsync(Cancel);
        var confirmed = await fresh.InvokeAsync<FirewallChangeSetInfo>(nameof(ICoreHub.ConfirmFirewallChanges), change.Id, Cancel);

        Assert.Contains("same SSH connection", same.Message, StringComparison.Ordinal);
        Assert.Equal(FirewallChangeState.Confirmed, confirmed.State);
        Assert.Contains("firewall.disarm", Mutations(harness));
        var audit = await AuditAsync(harness);
        Assert.Contains("firewall.confirm:denied", audit);
        Assert.Contains("firewall.confirm:success", audit);
    }

    [Fact]
    public async Task A_confirmation_the_core_cannot_place_is_refused()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Admin);
        var signedIn = await harness.SignInAsync();
        await using var first = harness.Hub(signedIn.AccessToken);
        await first.StartAsync(Cancel);
        var change = await first.InvokeAsync<FirewallChangeSetInfo>(nameof(ICoreHub.ApplyFirewallChanges), Open(80), Cancel);
        harness.Services.GetRequiredService<FakeCallerConnections>().Unplaced = true;
        await using var fresh = harness.Hub(signedIn.AccessToken);
        await fresh.StartAsync(Cancel);

        var refused = await Assert.ThrowsAsync<HubException>(() =>
            fresh.InvokeAsync<FirewallChangeSetInfo>(nameof(ICoreHub.ConfirmFirewallChanges), change.Id, Cancel));

        Assert.Contains("could not tell which SSH connection", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_change_from_a_connection_the_core_cannot_place_is_refused_without_the_phrase()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Admin);
        harness.Services.GetRequiredService<FakeCallerConnections>().Unplaced = true;
        await using var hub = await ConnectAsync(harness);

        var refused = await Assert.ThrowsAsync<HubException>(() =>
            hub.InvokeAsync<FirewallChangeSetInfo>(nameof(ICoreHub.ApplyFirewallChanges), Open(80), Cancel));

        Assert.Contains("could not tell which SSH connection", refused.Message, StringComparison.Ordinal);
        Assert.Empty(Mutations(harness));
    }

    [Fact]
    public async Task An_admin_reverts_a_change_by_hand()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Admin);
        var backend = harness.Services.GetRequiredService<FakeFirewallBackend>();
        var before = backend.State;
        await using var hub = await ConnectAsync(harness);
        var change = await hub.InvokeAsync<FirewallChangeSetInfo>(nameof(ICoreHub.ApplyFirewallChanges), Open(80), Cancel);

        var reverted = await hub.InvokeAsync<FirewallChangeSetInfo>(nameof(ICoreHub.RevertFirewallChanges), change.Id, Cancel);
        var history = await hub.InvokeAsync<FirewallChangeSetInfo[]>(nameof(ICoreHub.ListFirewallChangeSets), new FirewallChangeSetQuery(Limit: 5), Cancel);

        Assert.Equal(FirewallChangeState.RolledBack, reverted.State);
        Assert.Equal(FirewallRollbackCause.User, reverted.RolledBackBy);
        Assert.Same(before, backend.State);
        Assert.Equal(change.Id, Assert.Single(history).Id);
        Assert.Contains("firewall.revert:success", await AuditAsync(harness));
    }

    [Fact]
    public async Task A_bad_change_is_refused_with_the_reason_and_audited()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Admin);
        await using var hub = await ConnectAsync(harness);

        var refused = await Assert.ThrowsAsync<HubException>(() =>
            hub.InvokeAsync<FirewallChangeSetInfo>(nameof(ICoreHub.ApplyFirewallChanges), new FirewallChangeRequest([Add(Tcp(70000))]), Cancel));

        Assert.Contains("A port is a number from 1 to 65535", refused.Message, StringComparison.Ordinal);
        Assert.Contains("firewall.apply:failed", await AuditAsync(harness));
        Assert.Empty(Mutations(harness));
    }
}
