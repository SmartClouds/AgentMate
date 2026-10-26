using Runova.ServerCore.Contracts;
using Runova.ServerCore.Jobs;
using Runova.ServerCore.Platform;

namespace Runova.ServerCore.Tests;

/// <summary>Every call that would change the server, in order, so a test can prove one never happened.</summary>
internal sealed class MutationLog
{
    private readonly List<string> _entries = [];

    public IReadOnlyList<string> Entries
    {
        get
        {
            lock (_entries)
            {
                return [.. _entries];
            }
        }
    }

    public void Add(string entry)
    {
        lock (_entries)
        {
            _entries.Add(entry);
        }
    }
}

internal sealed class FakePackageManager(MutationLog mutations) : IPackageManager
{
    public string Name => "apt";

    public List<UpgradablePackage> Packages { get; } =
    [
        new("openssl", "3.0.13-0ubuntu3.5", "noble-updates,noble-security", Security: true, "amd64", "3.0.13-0ubuntu3.4"),
        new("curl", "8.5.0-2ubuntu10.5", "noble-updates", Security: false, "amd64", "8.5.0-2ubuntu10.4"),
    ];

    public RebootStatus Reboot { get; set; } = new(false, []);

    public AutoUpdatesInfo Automatic { get; set; } = new(Supported: true, Installed: true, Enabled: false, "unattended-upgrades");

    /// <summary>Held by an upgrade until a test releases it; completed means upgrades finish at once.</summary>
    public TaskCompletionSource UpgradeGate { get; set; } = CompletedGate();

    public Exception? ListFailure { get; set; }

    public int Lists { get; private set; }

    public static TaskCompletionSource CompletedGate()
    {
        var gate = new TaskCompletionSource();
        gate.SetResult();
        return gate;
    }

    public Task<IReadOnlyList<UpgradablePackage>> ListUpgradableAsync(CancellationToken cancellationToken)
    {
        Lists++;
        return ListFailure is { } failure
            ? Task.FromException<IReadOnlyList<UpgradablePackage>>(failure)
            : Task.FromResult<IReadOnlyList<UpgradablePackage>>([.. Packages]);
    }

    public Task RefreshIndexAsync(JobContext job, CancellationToken cancellationToken)
    {
        mutations.Add("packages.refresh");
        job.Log("Hit:1 http://archive.ubuntu.com/ubuntu noble InRelease", JobLogSource.Out);
        return Task.CompletedTask;
    }

    public async Task UpgradeAsync(bool securityOnly, JobContext job, CancellationToken cancellationToken)
    {
        mutations.Add(securityOnly ? "packages.upgrade-security" : "packages.upgrade");
        job.Log("Reading package lists...", JobLogSource.Out);
        await UpgradeGate.Task.WaitAsync(cancellationToken);
        Packages.RemoveAll(package => !securityOnly || package.Security);
    }

    public Task<AutoUpdatesInfo> GetAutomaticUpdatesAsync(CancellationToken cancellationToken) => Task.FromResult(Automatic);

    public Task SetAutomaticUpdatesAsync(bool enabled, JobContext job, CancellationToken cancellationToken)
    {
        mutations.Add($"packages.automatic={enabled}");
        Automatic = Automatic with { Enabled = enabled, Installed = true };
        return Task.CompletedTask;
    }

    public Task<RebootStatus> GetRebootStatusAsync(CancellationToken cancellationToken) => Task.FromResult(Reboot);
}

internal sealed class FakeServiceManager(MutationLog mutations) : IServiceManager
{
    public List<ServiceInfo> Services { get; } =
    [
        new("SSH", "ssh.service", "OpenBSD Secure Shell server", ServiceState.Active, "running", CanRestart: false, EnabledAtBoot: true),
        new("Docker", "docker.service", "Docker Application Container Engine", ServiceState.Active, "running", CanRestart: true, EnabledAtBoot: true),
        new("nginx", "nginx.service", "nginx.service", ServiceState.NotInstalled, "dead", CanRestart: false),
    ];

    public Task<IReadOnlyList<ServiceInfo>> ListAsync(CancellationToken cancellationToken) =>
        Task.FromResult<IReadOnlyList<ServiceInfo>>([.. Services]);

    public Task RestartAsync(ManagedService service, JobContext job, CancellationToken cancellationToken)
    {
        var unit = service == ManagedService.Docker ? "docker.service" : "nginx.service";
        if (Services.Single(s => s.Unit == unit).State == ServiceState.NotInstalled)
        {
            throw new JobFailedException($"{unit} is not installed on this server.");
        }

        mutations.Add($"service.restart={unit}");
        return Task.CompletedTask;
    }
}

internal sealed class FakePowerControl(MutationLog mutations) : IPowerControl
{
    public Task ScheduleRebootAsync(JobContext job, TimeSpan delay, CancellationToken cancellationToken)
    {
        mutations.Add($"power.reboot-in={delay.TotalSeconds}s");
        return Task.CompletedTask;
    }
}

internal sealed class FakeSystemInfoSource : ISystemInfoSource
{
    public static SystemInfo Info { get; } = new(
        "web-01",
        new OsInfo("ubuntu", "24.04", "Ubuntu 24.04.1 LTS", OsFamily.Debian, Supported: true),
        "6.8.0-45-generic",
        "x86_64",
        new CpuInfo("AMD EPYC 7B13", 4, 4, 1),
        8_000_000_000,
        1_000_000_000,
        [FakeSystemProbe.Disk("/", used: 40, total: 100)],
        [new NetworkInterfaceInfo("eth0", Up: true, ["203.0.113.10"])],
        ["203.0.113.10"],
        1_758_370_021_000,
        new TimeSyncInfo(true, true, "Etc/UTC", "systemd-timesyncd"),
        [],
        1_800_000_000_000,
        RebootRequired: false);

    public Task<SystemInfo> GetAsync(CancellationToken cancellationToken) => Task.FromResult(Info);
}
