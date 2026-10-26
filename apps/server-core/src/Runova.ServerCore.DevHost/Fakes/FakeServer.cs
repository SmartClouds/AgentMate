using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.DevHost.Fakes;

/// <summary>
/// The pretend machine behind the DevHost: an Ubuntu 24.04 server with a few updates waiting,
/// Docker and nginx running, and a reboot that takes it away for a few seconds. Shared by the fake
/// platform services, so an upgrade empties the list and a kernel update asks for a reboot.
/// </summary>
internal sealed class FakeServer(TimeProvider time)
{
    public static readonly TimeSpan RebootTakes = TimeSpan.FromSeconds(8);

    private readonly Lock _gate = new();

    private readonly List<UpgradablePackage> _packages =
    [
        new("base-files", "13ubuntu10.5", "noble-updates", Security: false, "amd64", "13ubuntu10.4"),
        new("curl", "8.5.0-2ubuntu10.6", "noble-updates,noble-security", Security: true, "amd64", "8.5.0-2ubuntu10.5"),
        new("docker-ce", "5:29.1.2-1~ubuntu.24.04~noble", "noble", Security: false, "amd64", "5:29.1.1-1~ubuntu.24.04~noble"),
        new("libssl3t64", "3.0.13-0ubuntu3.16", "noble-updates,noble-security", Security: true, "amd64", "3.0.13-0ubuntu3.15"),
        new("linux-image-generic", "6.8.0-47.47", "noble-updates,noble-security", Security: true, "amd64", "6.8.0-45.45"),
        new("openssl", "3.0.13-0ubuntu3.16", "noble-updates,noble-security", Security: true, "amd64", "3.0.13-0ubuntu3.15"),
        new("tzdata", "2026c-0ubuntu0.24.04", "noble-updates", Security: false, "all", "2026b-0ubuntu0.24.04"),
    ];

    private readonly Dictionary<string, long> _restartedAt = new(StringComparer.Ordinal);

    public long BootedAtUnixMs { get; private set; } = time.GetUtcNow().AddDays(-9).AddHours(-4).ToUnixTimeMilliseconds();

    public bool RebootRequired { get; private set; }

    public bool AutomaticUpdates { get; private set; }

    public bool Rebooting { get; private set; }

    public IReadOnlyList<UpgradablePackage> Packages
    {
        get
        {
            lock (_gate)
            {
                return [.. _packages];
            }
        }
    }

    public void Upgraded(IEnumerable<string> names)
    {
        lock (_gate)
        {
            var upgraded = names.ToHashSet(StringComparer.Ordinal);
            RebootRequired |= upgraded.Any(name => name.StartsWith("linux-image", StringComparison.Ordinal));
            _packages.RemoveAll(package => upgraded.Contains(package.Name));
        }
    }

    public void SetAutomaticUpdates(bool enabled)
    {
        lock (_gate)
        {
            AutomaticUpdates = enabled;
        }
    }

    public void Restarted(string unit)
    {
        lock (_gate)
        {
            _restartedAt[unit] = time.GetUtcNow().ToUnixTimeMilliseconds();
        }
    }

    public long ActiveSince(string unit)
    {
        lock (_gate)
        {
            return _restartedAt.TryGetValue(unit, out var at) ? at : BootedAtUnixMs + 12_000;
        }
    }

    public void BeginReboot()
    {
        lock (_gate)
        {
            Rebooting = true;
        }
    }

    public void FinishReboot()
    {
        lock (_gate)
        {
            BootedAtUnixMs = time.GetUtcNow().ToUnixTimeMilliseconds();
            RebootRequired = false;
            _restartedAt.Clear();
            Rebooting = false;
        }
    }
}
