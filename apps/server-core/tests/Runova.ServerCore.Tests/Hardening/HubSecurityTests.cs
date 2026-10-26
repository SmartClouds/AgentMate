using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.DevHost.Fakes;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Tests.Hardening;

/// <summary>
/// The Security center through a real hub connection: Admins read the checklist, Owners turn SSH
/// password login off after a step-up, and only over a connection that signed in with a key. No
/// change can lock the app out: one asked for over a password login is refused before anything is
/// written, one sshd would not run is put back at once, and one is only kept when another new
/// connection that signed in with a key confirms it.
/// </summary>
public sealed class HubSecurityTests
{
    private static readonly SshHardeningRequest _passwordsOff = new(DisablePasswordLogin: true, RestrictRootLogin: false);

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

    private static Task<SecurityChecklist> ChecklistAsync(HubConnection hub, string? available = null) =>
        hub.InvokeAsync<SecurityChecklist>(nameof(ICoreHub.GetSecurityChecklist), new SecurityChecklistRequest(available), Cancel);

    private static Task<SshHardeningChangeInfo> ApplyAsync(HubConnection hub, SshHardeningRequest? request = null) =>
        hub.InvokeAsync<SshHardeningChangeInfo>(nameof(ICoreHub.ApplySshHardening), request ?? _passwordsOff, Cancel);

    private static async Task<List<string>> AuditAsync(AuthHarness harness)
    {
        await using var scope = harness.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<CoreDbContext>();
        return await db.AuditEvents.OrderBy(e => e.Id).Select(e => e.Action + ":" + e.Result).ToListAsync(Cancel);
    }

    private static FakeSshMachine Sshd(AuthHarness harness) => harness.Services.GetRequiredService<FakeSshMachine>();

    private static FakeSshLoginLog Logins(AuthHarness harness) => harness.Services.GetRequiredService<FakeSshLoginLog>();

    [Fact]
    public async Task An_admin_reads_the_checklist_with_a_score_and_its_fixes()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Admin);
        await using var hub = await ConnectAsync(harness);

        var checklist = await ChecklistAsync(hub, available: "99.0.0");
        var items = checklist.Items.ToDictionary(item => item.Id);

        Assert.Equal(ChecklistStatus.Pass, items["firewall"].Status);
        Assert.Equal(ChecklistStatus.Fail, items["ssh-passwords"].Status);
        Assert.Equal(ChecklistFix.DisableSshPasswordLogin, items["ssh-passwords"].Fix);
        Assert.Equal(ChecklistStatus.Warn, items["ssh-root"].Status);
        Assert.Equal(ChecklistFix.EnableAutomaticUpdates, items["auto-updates"].Fix);
        Assert.Equal(ChecklistStatus.Warn, items["core-version"].Status);
        Assert.Equal(["99.0.0"], items["core-version"].Targets);
        Assert.Equal(ChecklistStatus.Pass, items["owners-2fa"].Status);
        Assert.InRange(checklist.Score, 1, 99);
        Assert.True(checklist.Ssh.PasswordLogin);
        Assert.Null(checklist.PendingSshChange);
    }

    [Fact]
    public async Task A_version_the_app_could_not_have_sent_is_ignored()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Admin);
        await using var hub = await ConnectAsync(harness);

        var checklist = await ChecklistAsync(hub, available: "1.0; rm -rf /");

        Assert.Equal(ChecklistStatus.Unknown, checklist.Items.Single(item => item.Id == "core-version").Status);
    }

    [Fact]
    public async Task An_owner_without_two_factor_is_offered_to_turn_it_on()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Owner);
        await using var hub = await ConnectAsync(harness);

        var item = (await ChecklistAsync(hub)).Items.Single(entry => entry.Id == "owners-2fa");

        Assert.Equal(ChecklistStatus.Fail, item.Status);
        Assert.Equal(ChecklistFix.EnableTwoFactor, item.Fix);
        Assert.Equal(["maria"], item.Targets);
    }

    [Theory]
    [InlineData(CoreRoles.Viewer)]
    [InlineData(CoreRoles.Operator)]
    public async Task Below_admin_the_checklist_is_refused(string role)
    {
        await using var harness = await AuthHarness.CreateAsync(role);
        await using var hub = await ConnectAsync(harness);

        var refused = await Assert.ThrowsAsync<HubException>(() => ChecklistAsync(hub));

        Assert.Contains("unauthorized", refused.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task An_admin_cannot_change_sshd()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Admin);
        await using var hub = await ConnectAsync(harness);
        await StepUpAsync(hub);

        var refused = await Assert.ThrowsAsync<HubException>(() => ApplyAsync(hub));

        Assert.Contains("unauthorized", refused.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Empty(Sshd(harness).Actions);
    }

    [Fact]
    public async Task An_owner_needs_a_step_up()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Owner);
        await using var hub = await ConnectAsync(harness);

        var refused = await Assert.ThrowsAsync<HubException>(() => ApplyAsync(hub));

        Assert.Contains("unauthorized", refused.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Empty(Sshd(harness).Actions);
    }

    [Theory]
    [InlineData("password")]
    [InlineData("keyboard-interactive/pam")]
    [InlineData(null)]
    public async Task Passwords_stay_on_unless_this_connection_signed_in_with_a_key(string? method)
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Owner);
        Logins(harness).DefaultMethod = method;
        await using var hub = await ConnectAsync(harness);
        await StepUpAsync(hub);

        var preview = await hub.InvokeAsync<SshHardeningPreview>(nameof(ICoreHub.PreviewSshHardening), _passwordsOff, Cancel);
        var refused = await Assert.ThrowsAsync<HubException>(() => ApplyAsync(hub));

        Assert.False(preview.Proof.KeyLoginProven);
        Assert.False(preview.Allowed);
        Assert.Contains("PasswordAuthentication no", preview.Content, StringComparison.Ordinal);
        Assert.Contains("Nothing was changed", refused.Message, StringComparison.Ordinal);
        Assert.Empty(Sshd(harness).Actions);
        Assert.Null(Sshd(harness).DropIn);
        Assert.True((await ChecklistAsync(hub)).Ssh.PasswordLogin);
        Assert.Contains("ssh.apply:denied", await AuditAsync(harness));
    }

    [Fact]
    public async Task A_change_is_kept_only_over_another_new_connection_that_signed_in_with_a_key()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Owner);
        await using var hub = await ConnectAsync(harness);
        await StepUpAsync(hub);

        var preview = await hub.InvokeAsync<SshHardeningPreview>(nameof(ICoreHub.PreviewSshHardening), _passwordsOff, Cancel);
        var change = await ApplyAsync(hub);
        var pending = (await ChecklistAsync(hub)).PendingSshChange;
        var sameConnection = await Assert.ThrowsAsync<HubException>(() =>
            hub.InvokeAsync<SshHardeningChangeInfo>(nameof(ICoreHub.ConfirmSshHardening), change.Id, Cancel));

        // A new connection that signed in with a password proves nothing about key logins.
        Logins(harness).DefaultMethod = "password";
        await using (var passwordHub = await ConnectAsync(harness))
        {
            var byPassword = await Assert.ThrowsAsync<HubException>(() =>
                passwordHub.InvokeAsync<SshHardeningChangeInfo>(nameof(ICoreHub.ConfirmSshHardening), change.Id, Cancel));
            Assert.Contains("key login still works", byPassword.Message, StringComparison.Ordinal);
        }

        Logins(harness).DefaultMethod = "publickey";
        await using var fresh = await ConnectAsync(harness);
        var kept = await fresh.InvokeAsync<SshHardeningChangeInfo>(nameof(ICoreHub.ConfirmSshHardening), change.Id, Cancel);
        var after = await ChecklistAsync(fresh);

        Assert.True(preview.Allowed);
        Assert.True(preview.Proof.KeyLoginProven);
        Assert.Equal(["write /etc/ssh/sshd_config.d/00-runova.conf", "sshd -t", "sshd -T", "systemctl reload ssh"], preview.Commands);
        Assert.Equal(SshHardeningState.AwaitingConfirmation, change.State);
        Assert.Equal(change.Id, pending?.Id);
        Assert.Contains("new SSH connection", sameConnection.Message, StringComparison.Ordinal);
        Assert.Equal(SshHardeningState.Confirmed, kept.State);
        Assert.Equal(["write", "test", "reload ssh"], Sshd(harness).Actions);
        Assert.Equal(preview.Content, Sshd(harness).DropIn);
        Assert.False(Sshd(harness).Running.PasswordLogin);
        Assert.Equal(["arm 60s", "disarm"], harness.Services.GetRequiredService<FakeSshHardeningTimer>().Actions);
        Assert.Equal(ChecklistStatus.Pass, after.Items.Single(item => item.Id == "ssh-passwords").Status);
        Assert.Null(after.PendingSshChange);
        var audit = await AuditAsync(harness);
        Assert.Contains("ssh.apply:success", audit);
        Assert.Contains("ssh.confirm:denied", audit);
        Assert.Contains("ssh.confirm:success", audit);
    }

    [Fact]
    public async Task Settings_sshd_refuses_are_put_back_at_once()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Owner);
        Sshd(harness).TestComplaint = "line 3: Bad configuration option";
        await using var hub = await ConnectAsync(harness);
        await StepUpAsync(hub);

        var refused = await Assert.ThrowsAsync<HubException>(() => ApplyAsync(hub));
        var checklist = await ChecklistAsync(hub);

        Assert.Contains("sshd refused the new settings", refused.Message, StringComparison.Ordinal);
        Assert.Contains("The old settings are back", refused.Message, StringComparison.Ordinal);
        Assert.Null(Sshd(harness).DropIn);
        Assert.Equal(["write", "test", "delete", "reload ssh"], Sshd(harness).Actions);
        Assert.True(checklist.Ssh.PasswordLogin);
        Assert.Null(checklist.PendingSshChange);
    }

    [Fact]
    public async Task A_drop_in_sshd_does_not_read_is_put_back_before_any_reload()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Owner);
        Sshd(harness).IgnoresDropIn = true;
        await using var hub = await ConnectAsync(harness);
        await StepUpAsync(hub);

        var refused = await Assert.ThrowsAsync<HubException>(() => ApplyAsync(hub));

        Assert.Contains("an earlier setting wins", refused.Message, StringComparison.Ordinal);
        Assert.Null(Sshd(harness).DropIn);
        Assert.Equal(["write", "test", "delete", "reload ssh"], Sshd(harness).Actions);
    }

    [Fact]
    public async Task Reverting_puts_the_old_settings_back_and_one_change_waits_at_a_time()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Owner);
        await using var hub = await ConnectAsync(harness);
        await StepUpAsync(hub);

        var change = await ApplyAsync(hub);
        var second = await Assert.ThrowsAsync<HubException>(() => ApplyAsync(hub, new SshHardeningRequest(false, true)));
        var reverted = await hub.InvokeAsync<SshHardeningChangeInfo>(nameof(ICoreHub.RevertSshHardening), change.Id, Cancel);
        var late = await Assert.ThrowsAsync<HubException>(() =>
            hub.InvokeAsync<SshHardeningChangeInfo>(nameof(ICoreHub.ConfirmSshHardening), change.Id, Cancel));

        Assert.Contains("waits for its confirmation", second.Message, StringComparison.Ordinal);
        Assert.Equal(SshHardeningState.RolledBack, reverted.State);
        Assert.Contains("already rolled back", late.Message, StringComparison.Ordinal);
        Assert.Null(Sshd(harness).DropIn);
        Assert.True(Sshd(harness).Running.PasswordLogin);
    }

    [Fact]
    public async Task A_change_nobody_keeps_goes_back_by_itself()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Owner);
        await using var hub = await ConnectAsync(harness);
        await StepUpAsync(hub);

        var change = await ApplyAsync(hub);
        harness.Clock!.Advance(TimeSpan.FromSeconds(85));
        await WaitUntilAsync(() => Sshd(harness).DropIn is null);
        var history = (await ChecklistAsync(hub)).PendingSshChange;

        Assert.Null(history);
        Assert.True(Sshd(harness).Running.PasswordLogin);
        await Assert.ThrowsAsync<HubException>(() =>
            hub.InvokeAsync<SshHardeningChangeInfo>(nameof(ICoreHub.ConfirmSshHardening), change.Id, Cancel));
    }

    private static async Task WaitUntilAsync(Func<bool> condition)
    {
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (!condition())
        {
            Assert.True(DateTime.UtcNow < deadline, "Timed out waiting for the change to settle.");
            await Task.Delay(50, Cancel);
        }
    }
}
