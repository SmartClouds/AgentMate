using Runova.ServerCore.Contracts;
using Runova.ServerCore.Hubs;
using Runova.ServerCore.Jobs;
using Runova.ServerCore.Platform;

namespace Runova.ServerCore.DevHost.Fakes;

/// <summary>Services as systemd would list them on the pretend server; restarts take a moment.</summary>
internal sealed class FakeServices(FakeServer server, TimeProvider time) : IServiceManager
{
    private static readonly (string Unit, string Name, string Description, bool Active, bool Restartable)[] _units =
    [
        ("ssh.service", "SSH", "OpenBSD Secure Shell server", true, false),
        ("cron.service", "Cron", "Regular background program processing daemon", true, false),
        ("systemd-timesyncd.service", "Time sync", "Network Time Synchronization", true, false),
        ("ufw.service", "Firewall (ufw)", "Uncomplicated firewall", false, false),
        ("unattended-upgrades.service", "Automatic updates", "Unattended Upgrades Shutdown", true, false),
        ("runova-core.service", "Runova core", "Runova Server Core", true, false),
        ("docker.service", "Docker", "Docker Application Container Engine", true, true),
        ("containerd.service", "containerd", "containerd container runtime", true, false),
        ("nginx.service", "nginx", "A high performance web server and a reverse proxy server", true, true),
    ];

    public Task<IReadOnlyList<ServiceInfo>> ListAsync(CancellationToken cancellationToken) =>
        Task.FromResult<IReadOnlyList<ServiceInfo>>([.. _units.Select((unit, index) => new ServiceInfo(
            unit.Name,
            unit.Unit,
            unit.Description,
            unit.Active ? ServiceState.Active : ServiceState.Inactive,
            unit.Active ? "running" : "dead",
            unit.Restartable,
            EnabledAtBoot: unit.Active,
            ActiveSinceUnixMs: unit.Active ? server.ActiveSince(unit.Unit) : null,
            MainPid: unit.Active ? 900 + index * 37 : null))]);

    public async Task RestartAsync(ManagedService service, JobContext job, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(job);
        var unit = service == ManagedService.Docker ? "docker.service" : "nginx.service";
        if (service == ManagedService.Nginx)
        {
            job.Log("Testing the nginx configuration first (nginx -t).");
            job.Log("nginx: the configuration file /etc/nginx/nginx.conf syntax is ok", JobLogSource.Err);
            job.Log("nginx: configuration file /etc/nginx/nginx.conf test is successful", JobLogSource.Err);
        }

        job.Log($"Restarting {unit}.");
        await Task.Delay(TimeSpan.FromSeconds(1.5), time, cancellationToken);
        server.Restarted(unit);
        job.ExitCode = 0;
    }
}

/// <summary>The pretend server's facts.</summary>
internal sealed class FakeSystemInfo(FakeServer server, FakeProbe probe, TimeProvider time) : ISystemInfoSource
{
    public Task<SystemInfo> GetAsync(CancellationToken cancellationToken) => Task.FromResult(new SystemInfo(
        "devhost",
        new OsInfo("ubuntu", "24.04", "Ubuntu 24.04.1 LTS", OsFamily.Debian, Supported: true),
        "6.8.0-45-generic",
        "x86_64",
        new CpuInfo("AMD EPYC 7B13", 4, 4, 1),
        8L * 1024 * 1024 * 1024,
        2L * 1024 * 1024 * 1024,
        [.. probe.ReadFilesystems()],
        [
            new NetworkInterfaceInfo("eth0", Up: true, ["203.0.113.10", "10.0.0.5", "2001:db8::10"], "52:54:00:12:34:56", 1000),
            new NetworkInterfaceInfo("eth1", Up: false, [], "52:54:00:12:34:57"),
        ],
        ["203.0.113.10", "2001:db8::10"],
        server.BootedAtUnixMs,
        new TimeSyncInfo(Synchronized: true, NtpEnabled: true, TimeZone: "Etc/UTC", Service: "systemd-timesyncd"),
        server.RebootRequired ? ["linux-image-6.8.0-47-generic"] : [],
        time.GetUtcNow().ToUnixTimeMilliseconds(),
        server.RebootRequired));
}

/// <summary>
/// A reboot, pretended: after the delay every connection drops and the DevHost answers nothing but
/// 503 for a few seconds, then comes back with a fresh boot time, as a real server would.
/// </summary>
internal sealed class FakePower(FakeServer server, HubConnections connections, TimeProvider time) : IPowerControl
{
    public Task ScheduleRebootAsync(JobContext job, TimeSpan delay, CancellationToken cancellationToken)
    {
        _ = Task.Run(
            async () =>
            {
                await Task.Delay(delay, time, CancellationToken.None);
                server.BeginReboot();
                connections.CloseAll();
                await Task.Delay(FakeServer.RebootTakes, time, CancellationToken.None);
                server.FinishReboot();
            },
            CancellationToken.None);
        return Task.CompletedTask;
    }
}
