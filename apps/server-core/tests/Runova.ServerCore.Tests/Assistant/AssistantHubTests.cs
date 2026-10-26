using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Runova.ServerCore.Assistant;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.DevHost.Fakes;
using Runova.ServerCore.Docker;
using Runova.ServerCore.Hubs;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Tests.Assistant;

/// <summary>
/// StreamExec through a real hub connection (E09 AC2): the core itself refuses a command that is
/// neither on the allowlist nor carrying a valid device-signed approval, whoever asks and whatever
/// the app believes. Nothing reaches the runner when it refuses, and every refusal is audited.
/// </summary>
public sealed class AssistantHubTests
{
    private const string Destructive = "rm -rf /";

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    internal sealed record Connected(AuthHarness Harness, HubConnection Hub, Guid SessionId) : IAsyncDisposable
    {
        public FakeExecRunner Runner => Harness.Services.GetRequiredService<FakeExecRunner>();

        public async ValueTask DisposeAsync()
        {
            await Hub.DisposeAsync();
            await Harness.DisposeAsync();
        }
    }

    internal static async Task<Connected> ConnectAsync(string role = CoreRoles.Admin, AuthHarness? existing = null)
    {
        var harness = existing ?? await AuthHarness.CreateAsync(role);
        var signedIn = await harness.SignInAsync();
        var hub = harness.Hub(signedIn.AccessToken);
        await hub.StartAsync(Cancel);
        return new Connected(harness, hub, signedIn.SessionId);
    }

    internal static async Task<ExecApproval> ApproveAsync(Connected connected, string command, Guid? sessionId = null, ECDsa? key = null)
    {
        var nonce = await connected.Hub.InvokeAsync<ExecApprovalNonce>(nameof(ICoreHub.NewExecApproval), Cancel);
        var message = ExecApprovals.Message(nonce.NonceId, nonce.Nonce, connected.Harness.DeviceId, sessionId ?? connected.SessionId, command);
        var signature = (key ?? connected.Harness.DeviceKey).SignData(
            Encoding.UTF8.GetBytes(message),
            HashAlgorithmName.SHA256,
            DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        return new ExecApproval(nonce.NonceId, Convert.ToBase64String(signature));
    }

    internal static async Task<List<ExecOutput>> ExecAsync(HubConnection hub, ExecRequest request)
    {
        var items = new List<ExecOutput>();
        await foreach (var item in hub.StreamAsync<ExecOutput>(nameof(ICoreHub.StreamExec), request, Cancel))
        {
            items.Add(item);
        }

        return items;
    }

    private static async Task<string> RefusedAsync(HubConnection hub, ExecRequest request) =>
        (await Assert.ThrowsAsync<HubException>(() => ExecAsync(hub, request))).Message;

    private static async Task<List<(string Action, string Result, string? Parameters)>> AuditAsync(AuthHarness harness)
    {
        await using var scope = harness.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<CoreDbContext>();
        return [.. (await db.AuditEvents.OrderBy(e => e.Id).ToListAsync(Cancel)).Select(e => (e.Action, e.Result, e.Parameters))];
    }

    [Fact]
    public async Task An_allowlisted_command_runs_unattended_from_its_words_and_is_audited()
    {
        await using var connected = await ConnectAsync();

        var output = await ExecAsync(connected.Hub, new ExecRequest("docker ps -a"));

        var plan = Assert.Single(connected.Runner.Ran);
        Assert.Equal("docker", plan.Program);
        Assert.Equal(["ps", "-a"], plan.Arguments);
        Assert.Contains(output.SelectMany(o => o.Lines), line => line.Text.Contains("shop-api-1", StringComparison.Ordinal));
        var last = output[^1];
        Assert.True(last.Ended);
        Assert.Equal(0, last.ExitCode);
        var audit = await AuditAsync(connected.Harness);
        Assert.Contains(audit, e => e.Action == "exec.run" && e.Result == "success" && e.Parameters!.Contains("\"approval\":\"allowlist\"", StringComparison.Ordinal));
        Assert.Contains(audit, e => e.Action == "exec.exit" && e.Result == "success");
    }

    [Fact]
    public async Task A_command_without_a_valid_approval_is_refused_and_never_reaches_the_runner()
    {
        await using var connected = await ConnectAsync();

        var refused = await RefusedAsync(connected.Hub, new ExecRequest(Destructive));
        var refusedFromAssistant = await RefusedAsync(connected.Hub, new ExecRequest(Destructive, FromAssistant: true));

        Assert.Contains(CoreHub.ExecNeedsApproval, refused, StringComparison.Ordinal);
        Assert.Contains(CoreHub.ExecNeedsApproval, refusedFromAssistant, StringComparison.Ordinal);
        Assert.Empty(connected.Runner.Ran);
        var denied = (await AuditAsync(connected.Harness)).Where(e => e.Action == "exec.run" && e.Result == "denied").ToList();
        Assert.Equal(2, denied.Count);
        Assert.Contains("\"assistant\":\"true\"", denied[1].Parameters, StringComparison.Ordinal);
    }

    [Fact]
    public async Task An_assistant_command_runs_unattended_only_after_auto_run_is_turned_on_with_a_step_up()
    {
        await using var connected = await ConnectAsync();
        var diagnostic = new ExecRequest("df -h", FromAssistant: true);

        Assert.Contains(CoreHub.ExecNeedsApproval, await RefusedAsync(connected.Hub, diagnostic), StringComparison.Ordinal);
        await Assert.ThrowsAsync<HubException>(() => connected.Hub.InvokeAsync<AssistantModeInfo>(nameof(ICoreHub.EnableAutoRunDiagnostics), Cancel));
        Assert.Equal(AssistantMode.ApproveEveryCommand, (await connected.Hub.InvokeAsync<AssistantModeInfo>(nameof(ICoreHub.GetAssistantMode), Cancel)).Mode);

        await connected.Hub.InvokeAsync<StepUpResponse>(nameof(ICoreHub.StepUp), new StepUpRequest(AuthHarness.Password), Cancel);
        var mode = await connected.Hub.InvokeAsync<AssistantModeInfo>(nameof(ICoreHub.EnableAutoRunDiagnostics), Cancel);
        Assert.Equal(AssistantMode.AutoRunDiagnostics, mode.Mode);
        Assert.Contains("journalctl", mode.Allowlist);

        await ExecAsync(connected.Hub, diagnostic);
        Assert.Single(connected.Runner.Ran);

        // The injected command is still refused: auto-run covers the allowlist and nothing more.
        Assert.Contains(CoreHub.ExecNeedsApproval, await RefusedAsync(connected.Hub, new ExecRequest(Destructive, FromAssistant: true)), StringComparison.Ordinal);
        Assert.Single(connected.Runner.Ran);

        var off = await connected.Hub.InvokeAsync<AssistantModeInfo>(nameof(ICoreHub.DisableAutoRunDiagnostics), Cancel);
        Assert.Equal(AssistantMode.ApproveEveryCommand, off.Mode);
        Assert.Contains(CoreHub.ExecNeedsApproval, await RefusedAsync(connected.Hub, diagnostic), StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_signed_approval_runs_the_exact_command_through_the_shell()
    {
        await using var connected = await ConnectAsync();
        const string command = "systemctl restart nginx && echo done";

        var output = await ExecAsync(connected.Hub, new ExecRequest(command, FromAssistant: true, Approval: await ApproveAsync(connected, command)));

        var plan = Assert.Single(connected.Runner.Ran);
        Assert.Equal(ExecPlan.Shell, plan.Program);
        Assert.Equal(["-c", command], plan.Arguments);
        Assert.True(output[^1].Ended);
        Assert.Contains(await AuditAsync(connected.Harness), e => e.Action == "exec.run" && e.Parameters!.Contains("\"approval\":\"signed\"", StringComparison.Ordinal));
    }

    [Fact]
    public async Task On_the_DevHost_an_approved_restart_brings_the_crash_looping_container_back()
    {
        await using var connected = await ConnectAsync();
        var engine = connected.Harness.Services.GetRequiredService<InMemoryDockerEngine>().WithCrashLoop();
        const string command = "docker restart " + InMemoryDockerEngine.CrashLoopContainer;

        var output = await ExecAsync(connected.Hub, new ExecRequest(command, FromAssistant: true, Approval: await ApproveAsync(connected, command)));

        Assert.True(output[^1].Ended);
        var sender = Assert.Single(await engine.ListContainersAsync(Cancel), c => c.Summary.Name == InMemoryDockerEngine.CrashLoopContainer);
        Assert.Equal(ContainerState.Running, sender.Summary.State);
    }

    [Fact]
    public async Task A_wrong_signature_a_replayed_nonce_and_a_changed_command_are_all_refused()
    {
        await using var connected = await ConnectAsync();
        using var stranger = ECDsa.Create(ECCurve.NamedCurves.nistP256);

        var wrongKey = await ApproveAsync(connected, Destructive, key: stranger);
        var tampered = (await ApproveAsync(connected, Destructive)) with { Signature = Convert.ToBase64String(new byte[64]) };
        var used = await ApproveAsync(connected, "uptime --pretty");
        await ExecAsync(connected.Hub, new ExecRequest("uptime --pretty", Approval: used));
        var signedForOther = await ApproveAsync(connected, "docker restart shop-api-1");

        Assert.Contains(CoreHub.ExecApprovalInvalid, await RefusedAsync(connected.Hub, new ExecRequest(Destructive, Approval: wrongKey)), StringComparison.Ordinal);
        Assert.Contains(CoreHub.ExecApprovalInvalid, await RefusedAsync(connected.Hub, new ExecRequest(Destructive, Approval: tampered)), StringComparison.Ordinal);
        Assert.Contains(CoreHub.ExecApprovalInvalid, await RefusedAsync(connected.Hub, new ExecRequest("uptime --pretty", Approval: used)), StringComparison.Ordinal);
        Assert.Contains(CoreHub.ExecApprovalInvalid, await RefusedAsync(connected.Hub, new ExecRequest(Destructive, Approval: signedForOther)), StringComparison.Ordinal);
        // A refused approval is spent too: sending it again with the right command does not help.
        Assert.Contains(CoreHub.ExecApprovalInvalid, await RefusedAsync(connected.Hub, new ExecRequest("docker restart shop-api-1", Approval: signedForOther)), StringComparison.Ordinal);

        Assert.Single(connected.Runner.Ran);
        Assert.Equal(5, (await AuditAsync(connected.Harness)).Count(e => e.Action == "exec.run" && e.Result == "denied" && e.Parameters!.Contains("invalid", StringComparison.Ordinal)));
    }

    [Fact]
    public async Task An_approval_is_good_only_on_its_own_session_and_before_it_expires()
    {
        await using var first = await ConnectAsync();
        await using var second = await ConnectAsync(existing: first.Harness);
        const string command = "systemctl restart nginx";

        // Signed for the first session's nonce, sent over the second session.
        var fromFirst = await ApproveAsync(first, command);
        Assert.Contains(CoreHub.ExecApprovalInvalid, await RefusedAsync(second.Hub, new ExecRequest(command, Approval: fromFirst with { })), StringComparison.Ordinal);

        // Signed with the right nonce but naming the other session.
        var misnamed = await ApproveAsync(second, command, sessionId: first.SessionId);
        Assert.Contains(CoreHub.ExecApprovalInvalid, await RefusedAsync(second.Hub, new ExecRequest(command, Approval: misnamed)), StringComparison.Ordinal);

        var late = await ApproveAsync(first, command);
        first.Harness.Clock!.Advance(ExecApprovals.Lifetime + TimeSpan.FromSeconds(1));
        Assert.Contains(CoreHub.ExecApprovalInvalid, await RefusedAsync(first.Hub, new ExecRequest(command, Approval: late)), StringComparison.Ordinal);

        Assert.Empty(first.Runner.Ran);
    }

    [Fact]
    public async Task Exec_is_for_admins_and_bad_requests_are_refused_before_anything_runs()
    {
        await using var operatorConnection = await ConnectAsync(CoreRoles.Operator);
        await Assert.ThrowsAsync<HubException>(() => ExecAsync(operatorConnection.Hub, new ExecRequest("uptime")));
        await Assert.ThrowsAsync<HubException>(() => operatorConnection.Hub.InvokeAsync<ExecApprovalNonce>(nameof(ICoreHub.NewExecApproval), Cancel));
        await Assert.ThrowsAsync<HubException>(() => operatorConnection.Hub.InvokeAsync<AssistantModeInfo>(nameof(ICoreHub.GetAssistantMode), Cancel));

        await using var connected = await ConnectAsync();
        await Assert.ThrowsAsync<HubException>(() => ExecAsync(connected.Hub, new ExecRequest("  ")));
        await Assert.ThrowsAsync<HubException>(() => ExecAsync(connected.Hub, new ExecRequest(new string('a', 5_000))));
        await Assert.ThrowsAsync<HubException>(() => ExecAsync(connected.Hub, new ExecRequest("uptime\0")));
        await Assert.ThrowsAsync<HubException>(() => ExecAsync(connected.Hub, new ExecRequest("uptime", WorkingDirectory: "relative")));
        await Assert.ThrowsAsync<HubException>(() => ExecAsync(connected.Hub, new ExecRequest("uptime", TimeoutSeconds: 0)));
        await Assert.ThrowsAsync<HubException>(() => ExecAsync(connected.Hub, new ExecRequest("uptime", TimeoutSeconds: 601)));
        Assert.Empty(connected.Runner.Ran);
    }

    [Fact]
    public async Task Stopping_the_stream_stops_the_command_and_the_audit_says_so()
    {
        await using var connected = await ConnectAsync();
        connected.Runner.Gate = new TaskCompletionSource();
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(Cancel);

        await using (var stream = connected.Hub.StreamAsync<ExecOutput>(nameof(ICoreHub.StreamExec), new ExecRequest("docker logs newsletter-sender-1"), stop.Token).GetAsyncEnumerator(stop.Token))
        {
            Assert.True(await stream.MoveNextAsync());
            await stop.CancelAsync();
        }

        await TestWait.UntilAsync(async () => (await AuditAsync(connected.Harness)).Any(e => e.Action == "exec.exit" && e.Result == "cancelled"));
    }
}

internal static class TestWait
{
    public static async Task UntilAsync(Func<Task<bool>> done, int seconds = 10)
    {
        var until = DateTime.UtcNow.AddSeconds(seconds);
        while (!await done())
        {
            Assert.True(DateTime.UtcNow < until, "The condition did not hold in time.");
            await Task.Delay(50, TestContext.Current.CancellationToken);
        }
    }
}
