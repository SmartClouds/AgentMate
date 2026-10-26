using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Tests;

/// <summary>
/// Direct TLS through the hub: every role reads it and its pin, only an Owner who stepped up turns
/// it on, the request is checked again on the core, and each change lands in the audit trail.
/// </summary>
public sealed class HubDirectTlsTests
{
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
            .Where(e => e.Action.StartsWith("directTls."))
            .OrderBy(e => e.Id)
            .Select(e => e.Action + ":" + e.Result)
            .ToListAsync(Cancel);
    }

    private static Task<DirectTlsStatus> EnableAsync(HubConnection hub, int port, string[]? sources = null) =>
        hub.InvokeAsync<DirectTlsStatus>(nameof(ICoreHub.EnableDirectTls), new DirectTlsRequest(port, sources), Cancel);

    [Fact]
    public async Task A_viewer_reads_the_mode_and_its_pin_but_cannot_turn_it_on()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Viewer, fakeClock: false);
        await using var hub = await ConnectAsync(harness, stepUp: true);

        var status = await hub.InvokeAsync<DirectTlsStatus>(nameof(ICoreHub.GetDirectTls), Cancel);
        var refused = await Assert.ThrowsAsync<HubException>(() => EnableAsync(hub, DirectTlsClient.FreePort()));
        var refusedOff = await Assert.ThrowsAsync<HubException>(() =>
            hub.InvokeAsync<DirectTlsStatus>(nameof(ICoreHub.DisableDirectTls), Cancel));

        Assert.False(status.Enabled);
        Assert.Equal(7443, status.DefaultPort);
        Assert.Equal(44, status.Pin.Length);
        Assert.Contains("unauthorized", refused.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("unauthorized", refusedOff.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task An_admin_cannot_turn_it_on()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Admin, fakeClock: false);
        await using var hub = await ConnectAsync(harness, stepUp: true);

        var refused = await Assert.ThrowsAsync<HubException>(() => EnableAsync(hub, DirectTlsClient.FreePort()));

        Assert.Contains("unauthorized", refused.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task An_owner_needs_a_step_up_to_turn_it_on()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Owner, fakeClock: false);
        await using var hub = await ConnectAsync(harness, stepUp: false);

        var refused = await Assert.ThrowsAsync<HubException>(() => EnableAsync(hub, DirectTlsClient.FreePort()));
        var status = await hub.InvokeAsync<DirectTlsStatus>(nameof(ICoreHub.GetDirectTls), Cancel);

        Assert.Contains("unauthorized", refused.Message, StringComparison.OrdinalIgnoreCase);
        Assert.False(status.Enabled);
    }

    [Fact]
    public async Task An_owner_turns_it_on_and_off_and_both_are_audited()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Owner, fakeClock: false);
        await using var hub = await ConnectAsync(harness, stepUp: true);
        var port = DirectTlsClient.FreePort();

        var on = await EnableAsync(hub, port, ["203.0.113.7", " 10.0.0.0/8 ", "203.0.113.7"]);
        var read = await hub.InvokeAsync<DirectTlsStatus>(nameof(ICoreHub.GetDirectTls), Cancel);
        var off = await hub.InvokeAsync<DirectTlsStatus>(nameof(ICoreHub.DisableDirectTls), Cancel);

        Assert.True(on.Enabled);
        Assert.True(on.Listening);
        Assert.Equal(port, on.Port);
        Assert.Equal(["203.0.113.7", "10.0.0.0/8"], on.Sources);
        Assert.Equal("maria", on.ChangedBy);
        Assert.Equal(on.Pin, read.Pin);
        Assert.True(read.Enabled);
        Assert.False(off.Enabled);
        Assert.False(off.Listening);
        Assert.Equal(port, off.Port);
        Assert.Equal(["directTls.enable:success", "directTls.disable:success"], await AuditAsync(harness));
    }

    [Theory]
    [InlineData(80, null, "1024")]
    [InlineData(22000, null, "SSH port")]
    [InlineData(70000, null, "1 to 65535")]
    [InlineData(8443, "10.0.0.1/8", "host bits")]
    [InlineData(8443, "0.0.0.0/0", "Leave the sources empty")]
    [InlineData(8443, "example.com", "not an IP address")]
    public async Task The_core_checks_the_request_again(int port, string? source, string expected)
    {
        await using var harness = await AuthHarness.CreateAsync(
            CoreRoles.Owner,
            fakeClock: false,
            services: (services, _) => services.AddSingleton<Firewall.ISshdSettings>(new FixedSshd(22000)));
        await using var hub = await ConnectAsync(harness, stepUp: true);

        var refused = await Assert.ThrowsAsync<HubException>(() => EnableAsync(hub, port, source is null ? null : [source]));
        var status = await hub.InvokeAsync<DirectTlsStatus>(nameof(ICoreHub.GetDirectTls), Cancel);

        Assert.Contains(expected, refused.Message, StringComparison.Ordinal);
        Assert.False(status.Enabled);
        Assert.Equal(["directTls.enable:denied"], await AuditAsync(harness));
    }

    private sealed class FixedSshd(int port) : Firewall.ISshdSettings
    {
        public Task<SshPortsInfo> ReadAsync(CancellationToken cancellationToken) => Task.FromResult(new SshPortsInfo([port]));
    }
}
