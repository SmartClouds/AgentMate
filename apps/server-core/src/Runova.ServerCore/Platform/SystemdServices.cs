using System.Globalization;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Hosting;
using Runova.ServerCore.Jobs;

namespace Runova.ServerCore.Platform;

/// <summary>
/// The services a server panel cares about, read with one `systemctl show`. Optional ones that are
/// not installed are left out; Docker and nginx are always listed, since the app offers them.
/// </summary>
internal sealed class SystemdServices(IProcessRunner runner, ISystemFiles files, OsInfo os) : IServiceManager
{
    public const string Properties =
        "--property=Id,Description,LoadState,ActiveState,SubState,UnitFileState,MainPID,ActiveEnterTimestampMonotonic";

    private static readonly (string Unit, string Name)[] _common =
    [
        (CoreLayout.Current.UnitFile, "Runova core"),
        ("docker.service", "Docker"),
        ("containerd.service", "containerd"),
        ("nginx.service", "nginx"),
        ("fail2ban.service", "Fail2Ban"),
    ];

    private static readonly (string Unit, string Name)[] _debian =
    [
        ("ssh.service", "SSH"),
        ("cron.service", "Cron"),
        ("systemd-timesyncd.service", "Time sync"),
        ("chrony.service", "Time sync (chrony)"),
        ("ufw.service", "Firewall (ufw)"),
        ("unattended-upgrades.service", "Automatic updates"),
    ];

    private static readonly (string Unit, string Name)[] _rhel =
    [
        ("sshd.service", "SSH"),
        ("crond.service", "Cron"),
        ("chronyd.service", "Time sync (chrony)"),
        ("firewalld.service", "Firewall (firewalld)"),
        ("dnf-automatic.timer", "Automatic updates"),
    ];

    private static readonly Dictionary<ManagedService, string> _managed = new()
    {
        [ManagedService.Docker] = "docker.service",
        [ManagedService.Nginx] = "nginx.service",
    };

    public async Task<IReadOnlyList<ServiceInfo>> ListAsync(CancellationToken cancellationToken)
    {
        (string Unit, string Name)[] units = os.Family switch
        {
            OsFamily.Debian => [.. _debian, .. _common],
            OsFamily.Rhel => [.. _rhel, .. _common],
            _ => [.. _debian, .. _rhel, .. _common],
        };
        var names = units.ToDictionary(unit => unit.Unit, unit => unit.Name, StringComparer.Ordinal);
        var bootedAt = files.ReadText("/proc/stat") is { } stat ? ProcParsers.ParseBootTime(stat) * 1000 : 0;

        var services = new List<ServiceInfo>();
        foreach (var block in await ShowAsync([.. units.Select(unit => unit.Unit)], cancellationToken))
        {
            var service = ToService(block, names, bootedAt);
            if (service is not null && (service.State != ServiceState.NotInstalled || _managed.ContainsValue(service.Unit)))
            {
                services.Add(service);
            }
        }

        return services;
    }

    public async Task RestartAsync(ManagedService service, JobContext job, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(job);
        if (!_managed.TryGetValue(service, out var unit))
        {
            throw new ArgumentOutOfRangeException(nameof(service), "Only Docker and nginx can be restarted from the app.");
        }

        var shown = service == ManagedService.Docker ? "Docker" : "nginx";
        var block = (await ShowAsync([unit], cancellationToken))
            .FirstOrDefault(candidate => candidate.GetValueOrDefault("Id") == unit);
        var state = block is null
            ? ServiceState.NotInstalled
            : SystemctlOutput.StateOf(Value(block, "LoadState"), Value(block, "ActiveState"), Value(block, "SubState"));
        if (state == ServiceState.NotInstalled)
        {
            throw new JobFailedException($"{shown} is not installed on this server.");
        }

        if (service == ManagedService.Nginx)
        {
            job.Log("Testing the nginx configuration first (nginx -t).");
            var test = await runner.RunAsync(
                new ProcessSpec { Program = "nginx", Arguments = ["-t"], Timeout = TimeSpan.FromSeconds(30) },
                onLine: null,
                cancellationToken);
            LogOutput(job, test);
            if (!test.Succeeded)
            {
                job.ExitCode = test.ExitCode;
                throw new JobFailedException("The nginx configuration test failed, so nginx was not restarted. The log shows why.", test.ExitCode);
            }
        }

        job.Log($"Restarting {unit}.");
        var restart = await runner.RunAsync(
            new ProcessSpec { Program = "systemctl", Arguments = ["restart", unit], Timeout = TimeSpan.FromMinutes(3) },
            onLine: null,
            cancellationToken);
        LogOutput(job, restart);
        job.ExitCode = restart.ExitCode;
        if (!restart.Succeeded)
        {
            throw new JobFailedException(
                restart.TimedOut ? $"{shown} did not finish restarting within three minutes." : $"systemctl could not restart {unit} (exit code {restart.ExitCode}).",
                restart.ExitCode);
        }

        job.Log($"{shown} restarted.");
    }

    private async Task<IReadOnlyList<IReadOnlyDictionary<string, string>>> ShowAsync(string[] units, CancellationToken cancellationToken)
    {
        var result = await runner.RunAsync(
            new ProcessSpec { Program = "systemctl", Arguments = ["show", Properties, .. units], Timeout = TimeSpan.FromSeconds(20) },
            onLine: null,
            cancellationToken);
        if (!result.Succeeded)
        {
            throw new ProcessFailedException($"systemctl show failed: {result.StandardError.Trim()}");
        }

        return SystemctlOutput.ParseShow(result.StandardOutput);
    }

    private static ServiceInfo? ToService(IReadOnlyDictionary<string, string> block, Dictionary<string, string> names, long bootedAt)
    {
        var unit = Value(block, "Id");
        if (unit.Length == 0)
        {
            return null;
        }

        var state = SystemctlOutput.StateOf(Value(block, "LoadState"), Value(block, "ActiveState"), Value(block, "SubState"));
        var enabled = Value(block, "UnitFileState") switch
        {
            "enabled" or "enabled-runtime" => true,
            "disabled" or "masked" or "masked-runtime" => (bool?)false,
            _ => null,
        };
        int? mainPid = int.TryParse(Value(block, "MainPID"), NumberStyles.None, CultureInfo.InvariantCulture, out var pid) && pid > 0 ? pid : null;
        long? activeSince = state is ServiceState.Active or ServiceState.Reloading
            && long.TryParse(Value(block, "ActiveEnterTimestampMonotonic"), NumberStyles.None, CultureInfo.InvariantCulture, out var monotonic)
            && monotonic > 0 && bootedAt > 0
            ? bootedAt + monotonic / 1000
            : null;
        var description = Value(block, "Description");
        return new ServiceInfo(
            names.GetValueOrDefault(unit, description),
            unit,
            description,
            state,
            Value(block, "SubState"),
            _managed.ContainsValue(unit) && state != ServiceState.NotInstalled,
            enabled,
            activeSince,
            mainPid);
    }

    private static string Value(IReadOnlyDictionary<string, string> block, string key) => block.GetValueOrDefault(key, string.Empty);

    private static void LogOutput(JobContext job, ProcessResult result)
    {
        foreach (var line in result.StandardOutput.Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            job.Log(line.TrimEnd('\r'), JobLogSource.Out);
        }

        foreach (var line in result.StandardError.Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            job.Log(line.TrimEnd('\r'), JobLogSource.Err);
        }
    }
}

/// <summary>A reboot from a transient timer, so the job records success before the machine goes down.</summary>
internal sealed class SystemdPower(SystemdRunner units) : IPowerControl
{
    public Task ScheduleRebootAsync(JobContext job, TimeSpan delay, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(job);
        return units.ScheduleAsync(
            job.UnitFor("reboot"),
            "Reboot the server",
            new ProcessSpec { Program = "/usr/bin/systemctl", Arguments = ["reboot"] },
            delay,
            cancellationToken);
    }
}
