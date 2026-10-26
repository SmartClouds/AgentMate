using System.Collections.Concurrent;
using System.Net;
using Microsoft.AspNetCore.Http;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Firewall;
using Runova.ServerCore.Hosting;
using static Runova.ServerCore.Tests.FirewallTestData;

namespace Runova.ServerCore.Tests;

/// <summary>
/// The firewall behind the test host: an active ufw in memory with SSH allowed. What would change
/// the server lands in the mutation log, so a test can prove a refused change touched nothing.
/// </summary>
internal sealed class FakeFirewallBackend(MutationLog mutations) : IFirewallBackendSource, IFirewallBackend
{
    private readonly ConcurrentDictionary<string, FirewallState> _saved = new(StringComparer.Ordinal);

    public FirewallState State { get; set; } = Ufw(rules: [Allow(22)]);

    public FirewallBackendKind Kind => State.Backend;

    public IFirewallBackend Current() => this;

    public Task<FirewallState> ReadAsync(CancellationToken cancellationToken) => Task.FromResult(State);

    public IReadOnlyList<FirewallStep> Steps(FirewallChangePlan plan) =>
    [
        .. plan.Added.Select(rule => new FirewallStep($"add {FirewallEvaluation.Describe(rule)}")),
        .. plan.Removed.Select(rule => new FirewallStep($"remove {FirewallEvaluation.Describe(rule)}")),
        .. plan.DefaultIncoming is { } policy ? [new FirewallStep($"default {policy}")] : Array.Empty<FirewallStep>(),
        .. plan.Enable is { } on ? [new FirewallStep(on ? "enable" : "disable")] : Array.Empty<FirewallStep>(),
    ];

    public Task ApplyAsync(FirewallChangePlan plan, IReadOnlyList<FirewallStep> steps, Action<string> log, CancellationToken cancellationToken)
    {
        mutations.Add($"firewall.apply={plan.Summary}");
        State = plan.Result;
        return Task.CompletedTask;
    }

    public Task<FirewallSnapshot> SnapshotAsync(CancellationToken cancellationToken)
    {
        var token = Guid.NewGuid().ToString("N");
        _saved[token] = State;
        return Task.FromResult(new FirewallSnapshot(Kind, [new SnapshotFile("/memory", token, UnixFileMode.UserRead)], 0));
    }

    public Task RestoreAsync(FirewallSnapshot snapshot, Action<string> log, CancellationToken cancellationToken)
    {
        mutations.Add("firewall.restore");
        State = _saved[snapshot.Files[0].Content!];
        return Task.CompletedTask;
    }
}

/// <summary>The rollback timer in memory: armed and disarmed in the mutation log, reverting in-process.</summary>
internal sealed class FakeFirewallTimer(MutationLog mutations, FakeFirewallBackend firewall, CoreDirectories directories, TimeProvider time)
    : IFirewallTimer
{
    public Task ArmAsync(Guid changeSetId, TimeSpan delay, CancellationToken cancellationToken)
    {
        mutations.Add($"firewall.arm={delay.TotalSeconds}s");
        return Task.CompletedTask;
    }

    public Task DisarmAsync(Guid changeSetId, CancellationToken cancellationToken)
    {
        mutations.Add("firewall.disarm");
        return Task.CompletedTask;
    }

    public Task<ScheduleState> StateAsync(Guid changeSetId, CancellationToken cancellationToken) => Task.FromResult(ScheduleState.Waiting);

    public Task RevertNowAsync(Guid changeSetId, CancellationToken cancellationToken) =>
        FirewallRevert.RunAsync(new FirewallChangeFiles(directories.Data, changeSetId), _ => firewall, time, _ => { }, cancellationToken);
}

internal sealed class FakeSshd : ISshdSettings
{
    public Task<SshPortsInfo> ReadAsync(CancellationToken cancellationToken) => Task.FromResult(new SshPortsInfo([22]));
}

/// <summary>
/// Each hub connection is an SSH connection of its own (a client port of its own), the way the
/// app makes one per call; a test can mark one as one the core cannot place.
/// </summary>
internal sealed class FakeCallerConnections : ICallerConnections
{
    private readonly ConcurrentDictionary<string, int> _ports = new(StringComparer.Ordinal);
    private int _next = 50_000;

    public bool Unplaced { get; set; }

    public CallerConnection Identify(HttpContext? http, string hubConnectionId, IReadOnlyCollection<int> sshPorts)
    {
        if (Unplaced)
        {
            return new CallerConnection(null, $"hub {hubConnectionId}");
        }

        var port = _ports.GetOrAdd(hubConnectionId, _ => Interlocked.Increment(ref _next));
        return new CallerConnection(new SshEndpoint(App, port, IPAddress.Parse("192.0.2.10"), 22), $"hub {hubConnectionId}");
    }
}

internal sealed class FakeExposure : IExposureSource
{
    public Task<ExposureInventory> ReadAsync(CancellationToken cancellationToken) => Task.FromResult(new ExposureInventory(
        [new ListeningSocketInfo(FirewallProtocol.Tcp, "0.0.0.0", 22, ExposureScope.Public, ExposureFirewall.Open, "sshd", 88)],
        [],
        DockerAvailable: false,
        1_800_000_000_000));
}
