using System.Collections.Concurrent;
using System.Net;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Docker;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Firewall;
using Runova.ServerCore.Hosting;

namespace Runova.ServerCore.DevHost.Fakes;

/// <summary>
/// The pretend server's firewall: ufw, on, with SSH, HTTP and HTTPS open, PostgreSQL open to the
/// private network and a scanner blocked. Changes take a moment, like ufw's, and run through the
/// core's real planner, guard and change sets; only the machine underneath is pretend.
/// </summary>
internal sealed class FakeFirewall(TimeProvider time) : IFirewallBackendSource, IFirewallBackend
{
    private readonly ConcurrentDictionary<string, FirewallState> _saved = new(StringComparer.Ordinal);
    private readonly Lock _gate = new();

    private FirewallState _state = new()
    {
        Backend = FirewallBackendKind.Ufw,
        Active = true,
        DefaultIncoming = FirewallPolicy.Deny,
        DefaultOutgoing = FirewallPolicy.Allow,
        Rules =
        [
            Rule(FirewallAction.Deny, null, FirewallProtocol.Any, "198.51.100.23", 0, "port scanner"),
            Rule(FirewallAction.Allow, 22, FirewallProtocol.Tcp, null, 1, "ssh"),
            Rule(FirewallAction.Allow, 80, FirewallProtocol.Tcp, null, 2, null),
            Rule(FirewallAction.Allow, 443, FirewallProtocol.Tcp, null, 3, null),
            Rule(FirewallAction.Allow, 5432, FirewallProtocol.Tcp, "10.0.0.0/8", 4, "app servers"),
        ],
    };

    public FirewallBackendKind Kind => FirewallBackendKind.Ufw;

    public FirewallState State
    {
        get
        {
            lock (_gate)
            {
                return _state;
            }
        }

        private set
        {
            lock (_gate)
            {
                _state = value;
            }
        }
    }

    public IFirewallBackend Current() => this;

    public Task<FirewallState> ReadAsync(CancellationToken cancellationToken) => Task.FromResult(State);

    /// <summary>The ufw command lines the real backend would run, for the preview.</summary>
    public IReadOnlyList<FirewallStep> Steps(FirewallChangePlan plan)
    {
        ArgumentNullException.ThrowIfNull(plan);
        var steps = new List<FirewallStep>();
        foreach (var rule in plan.Added)
        {
            var words = new List<string>();
            if (FirewallEvaluation.Blocks(rule))
            {
                words.Add("prepend");
            }

            words.Add(UfwRules.ActionWord(rule.Action));
            words.AddRange(UfwRules.Spec(rule));
            if (rule.Comment is { } comment)
            {
                words.Add("comment");
                words.Add($"'{comment}'");
            }

            steps.Add(new FirewallStep("ufw " + string.Join(' ', words)));
        }

        steps.AddRange(plan.Removed.Select(rule =>
            new FirewallStep($"ufw --force delete {UfwRules.ActionWord(rule.Action)} {string.Join(' ', UfwRules.Spec(rule))}")));
        if (plan.DefaultIncoming is { } policy)
        {
            steps.Add(new FirewallStep($"ufw default {FirewallEvaluation.Word(policy)} incoming"));
        }

        if (plan.Enable is { } on)
        {
            steps.Add(new FirewallStep(on ? "ufw --force enable" : "ufw disable"));
        }

        return steps;
    }

    public async Task ApplyAsync(FirewallChangePlan plan, IReadOnlyList<FirewallStep> steps, Action<string> log, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(steps);
        ArgumentNullException.ThrowIfNull(log);
        foreach (var step in steps)
        {
            log(step.Display);
            await Task.Delay(TimeSpan.FromMilliseconds(400), time, cancellationToken);
        }

        State = plan.Result;
    }

    public Task<FirewallSnapshot> SnapshotAsync(CancellationToken cancellationToken)
    {
        var token = Guid.NewGuid().ToString("N");
        _saved[token] = State;
        return Task.FromResult(new FirewallSnapshot(Kind, [new SnapshotFile("/devhost/ufw", token, UnixFileMode.UserRead | UnixFileMode.UserWrite)], 0));
    }

    public Task RestoreAsync(FirewallSnapshot snapshot, Action<string> log, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        ArgumentNullException.ThrowIfNull(log);
        if (snapshot.Files is not [{ Content: { } token }] || !_saved.TryGetValue(token, out var saved))
        {
            throw new FirewallStepFailedException("The DevHost has no such saved firewall.");
        }

        log("ufw reload");
        State = saved;
        return Task.CompletedTask;
    }

    private static FirewallRule Rule(FirewallAction action, int? port, FirewallProtocol protocol, string? source, int order, string? comment)
    {
        IPNetwork? network = null;
        if (source is not null && FirewallAddresses.TryParseNetwork(source, out var parsed, out _))
        {
            network = parsed;
        }

        return new FirewallRule
        {
            Action = action,
            Shape = "ufw",
            Protocol = protocol,
            Ports = port is int single ? new PortRange(single, single) : null,
            Source = network,
            Families = network is { } n ? FirewallAddresses.IsIpv6(n) ? FirewallFamilies.Ipv6 : FirewallFamilies.Ipv4 : FirewallFamilies.Both,
            Comment = comment,
            Ipv4Order = order,
            Ipv6Order = order,
        };
    }
}

/// <summary>
/// The rollback timer, kept by the DevHost instead of systemd: it really fires after the confirm
/// window and puts the saved rules back through the same revert as the real one.
/// </summary>
internal sealed class FakeFirewallTimer(FakeFirewall firewall, CoreDirectories directories, TimeProvider time) : IFirewallTimer, IDisposable
{
    private readonly ConcurrentDictionary<Guid, CancellationTokenSource> _armed = new();

    public Task ArmAsync(Guid changeSetId, TimeSpan delay, CancellationToken cancellationToken)
    {
        var disarm = new CancellationTokenSource();
        _armed[changeSetId] = disarm;
        _ = Task.Run(
            async () =>
            {
                try
                {
                    await Task.Delay(delay, time, disarm.Token);
                }
                catch (OperationCanceledException)
                {
                    return;
                }

                await RevertNowAsync(changeSetId, CancellationToken.None);
                _armed.TryRemove(changeSetId, out _);
            },
            CancellationToken.None);
        return Task.CompletedTask;
    }

    public async Task DisarmAsync(Guid changeSetId, CancellationToken cancellationToken)
    {
        if (_armed.TryRemove(changeSetId, out var disarm))
        {
            await disarm.CancelAsync();
            disarm.Dispose();
        }
    }

    public Task<ScheduleState> StateAsync(Guid changeSetId, CancellationToken cancellationToken) =>
        Task.FromResult(_armed.ContainsKey(changeSetId) ? ScheduleState.Waiting : ScheduleState.Gone);

    public Task RevertNowAsync(Guid changeSetId, CancellationToken cancellationToken) =>
        FirewallRevert.RunAsync(new FirewallChangeFiles(directories.Data, changeSetId), _ => firewall, time, _ => { }, cancellationToken);

    public void Dispose()
    {
        foreach (var disarm in _armed.Values)
        {
            disarm.Cancel();
            disarm.Dispose();
        }
    }
}

internal sealed class FakeSshd : ISshdSettings
{
    public Task<SshPortsInfo> ReadAsync(CancellationToken cancellationToken) => Task.FromResult(new SshPortsInfo([22]));
}

/// <summary>
/// The DevHost has no SSH: each TCP connection to it stands for an SSH connection from this
/// computer, so a confirmation through a fresh connection counts as a new one, as on a server.
/// </summary>
internal sealed class FakeCallerConnections : ICallerConnections
{
    private static readonly IPAddress _client = IPAddress.Parse("203.0.113.50");
    private static readonly IPAddress _server = IPAddress.Parse("203.0.113.10");

    public CallerConnection Identify(HttpContext? http, string hubConnectionId, IReadOnlyCollection<int> sshPorts)
    {
        var port = http?.Connection.RemotePort is int remote and > 0 ? remote : 50_000;
        return new CallerConnection(new SshEndpoint(_client, port, _server, 22), $"connection {http?.Connection.Id ?? hubConnectionId}");
    }
}

/// <summary>
/// What listens on the pretend server, judged against the pretend firewall as it is now, and the
/// ports the pretend Docker Engine publishes: its seeded projects and whatever the simulated
/// compose started, so "make private" can be seen to work.
/// </summary>
internal sealed class FakeExposure(FakeFirewall firewall, InMemoryDockerEngine engine, TimeProvider time) : IExposureSource
{
    private static readonly (FirewallProtocol Protocol, string Address, int Port, string Process, int Pid)[] _sockets =
    [
        (FirewallProtocol.Tcp, "0.0.0.0", 22, "sshd", 812),
        (FirewallProtocol.Tcp, "::", 22, "sshd", 812),
        (FirewallProtocol.Tcp, "0.0.0.0", 80, "nginx", 1403),
        (FirewallProtocol.Tcp, "0.0.0.0", 443, "nginx", 1403),
        (FirewallProtocol.Tcp, "0.0.0.0", 3000, "node", 2240),
        (FirewallProtocol.Tcp, "127.0.0.1", 5432, "postgres", 1188),
        (FirewallProtocol.Tcp, "::1", 6379, "redis-server", 1210),
        (FirewallProtocol.Udp, "127.0.0.53", 53, "systemd-resolve", 640),
        (FirewallProtocol.Udp, "0.0.0.0", 51820, "wg-quick", 1702),
    ];

    public async Task<ExposureInventory> ReadAsync(CancellationToken cancellationToken)
    {
        var state = firewall.State;
        ListeningSocketInfo[] sockets =
        [
            .. _sockets.Select(socket =>
            {
                var address = IPAddress.Parse(socket.Address);
                return new ListeningSocketInfo(
                    socket.Protocol,
                    socket.Address,
                    socket.Port,
                    ExposureParsers.Scope(address),
                    ExposureParsers.Judge(state, socket.Protocol, address, socket.Port),
                    socket.Process,
                    socket.Pid);
            }),
        ];
        var running = (await engine.ListContainersAsync(cancellationToken))
            .Select(container => container.Summary)
            .Where(container => container.State == ContainerState.Running);
        ContainerPortInfo[] containers =
        [
            .. running.SelectMany(container => container.Ports
                .Where(port => port.HostPort is not null)
                .Select(port =>
                {
                    var host = port.HostIp ?? "0.0.0.0";
                    var scope = ExposureParsers.Scope(IPAddress.Parse(host));
                    return new ContainerPortInfo(
                        container.Id,
                        container.Name,
                        container.Image,
                        port.Protocol == "udp" ? FirewallProtocol.Udp : FirewallProtocol.Tcp,
                        host,
                        port.HostPort!.Value,
                        port.PrivatePort,
                        scope,
                        scope == ExposureScope.Local ? ExposureFirewall.NotApplicable : ExposureFirewall.Bypassed);
                })),
        ];
        return new ExposureInventory(sockets, containers, DockerAvailable: true, time.GetUtcNow().ToUnixTimeMilliseconds());
    }
}
