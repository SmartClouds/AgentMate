using System.Collections.Concurrent;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Firewall;
using Runova.ServerCore.Hardening;

namespace Runova.ServerCore.DevHost.Fakes;

/// <summary>
/// The pretend server's sshd: passwords on and root allowed in, like a fresh VPS. Its drop-in
/// lives in memory and sshd -T reads it the way the real one would (the first value wins, and
/// Runova's drop-in comes first). Every change it makes is listed in Actions.
/// </summary>
internal sealed class FakeSshMachine : ISshMachine
{
    private readonly Lock _gate = new();
    private readonly List<string> _actions = [];
    private string? _dropIn;

    public FakeSshMachine()
    {
        Running = Effective();
    }

    public string ReloadUnit => "ssh";

    /// <summary>What sshd_config itself says, below the drop-in.</summary>
    public string BaseConfig { get; set; } = "port 22\npasswordauthentication yes\nkbdinteractiveauthentication no\npubkeyauthentication yes\npermitrootlogin yes\n";

    /// <summary>When set, sshd -t fails with these words.</summary>
    public string? TestComplaint { get; set; }

    /// <summary>When on, sshd behaves as if sshd_config never included the drop-in folder.</summary>
    public bool IgnoresDropIn { get; set; }

    public IReadOnlyList<string> Actions
    {
        get
        {
            lock (_gate)
            {
                return [.. _actions];
            }
        }
    }

    public string? DropIn
    {
        get
        {
            lock (_gate)
            {
                return _dropIn;
            }
        }
    }

    /// <summary>sshd's effective settings as it runs now: what it loaded at its last reload.</summary>
    public SshPolicyInfo Running { get; private set; }

    public Task<SshPolicyInfo> ReadAsync(CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            return Task.FromResult(Effective());
        }
    }

    public string? ReadDropIn() => DropIn;

    public void WriteDropIn(string content)
    {
        lock (_gate)
        {
            _dropIn = content;
            _actions.Add("write");
        }
    }

    public void DeleteDropIn()
    {
        lock (_gate)
        {
            _dropIn = null;
            _actions.Add("delete");
        }
    }

    public Task<string?> TestAsync(CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            _actions.Add("test");
            return Task.FromResult(TestComplaint);
        }
    }

    public Task ReloadAsync(string unit, CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            _actions.Add($"reload {unit}");
            Running = Effective();
        }

        return Task.CompletedTask;
    }

    private SshPolicyInfo Effective()
    {
        var text = IgnoresDropIn || _dropIn is null ? BaseConfig : _dropIn + BaseConfig;
        return SshdPolicy.Parse(text, _dropIn is not null);
    }
}

/// <summary>
/// The pretend server's sign-in log. The DevHost has no SSH, so each TCP connection stands for an
/// SSH connection that signed in with a key, as the app's would on a server set up for keys; a
/// test can make a connection's port sign in some other way.
/// </summary>
internal sealed class FakeSshLoginLog(TimeProvider time) : ISshLoginLog
{
    private readonly ConcurrentDictionary<int, string> _methods = new();

    /// <summary>How a connection signed in when nothing else was said for its port; null for none logged.</summary>
    public string? DefaultMethod { get; set; } = SshLoginLines.KeyMethod;

    public void SignedInWith(int clientPort, string method) => _methods[clientPort] = method;

    public Task<SshLogin?> FindAsync(SshEndpoint connection, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(connection);
        var method = _methods.TryGetValue(connection.ClientPort, out var chosen) ? chosen : DefaultMethod;
        return Task.FromResult(method is null
            ? null
            : new SshLogin(method, "dev", connection.Client, connection.ClientPort, time.GetUtcNow().ToUnixTimeMilliseconds()));
    }
}

/// <summary>The rollback timer in memory; the core's own monitor reverts a change nobody kept.</summary>
internal sealed class FakeSshHardeningTimer : ISshHardeningTimer
{
    private readonly ConcurrentQueue<string> _actions = new();

    public IReadOnlyList<string> Actions => [.. _actions];

    public Task ArmAsync(Guid changeId, TimeSpan delay, CancellationToken cancellationToken)
    {
        _actions.Enqueue($"arm {delay.TotalSeconds}s");
        return Task.CompletedTask;
    }

    public Task DisarmAsync(Guid changeId, CancellationToken cancellationToken)
    {
        _actions.Enqueue("disarm");
        return Task.CompletedTask;
    }
}
