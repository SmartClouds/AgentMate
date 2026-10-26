using Runova.ServerCore.Contracts;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Jobs;

namespace Runova.ServerCore.Platform;

/// <summary>
/// dnf on RHEL, Rocky, Alma and CentOS Stream. Security updates are what the distribution's
/// advisories (updateinfo) mark as such; CentOS Stream publishes none, so it has no security-only
/// list. Automatic updates are dnf-automatic with its timer.
/// </summary>
internal sealed class DnfPackageManager(IProcessRunner runner, SystemdRunner units, ISystemFiles files) : IPackageManager
{
    public const string AutomaticConfPath = "/etc/dnf/automatic.conf";

    private const string Dnf = "/usr/bin/dnf";

    private const string NeedsRestarting = "/usr/bin/needs-restarting";

    private const string Timer = "dnf-automatic.timer";

    private const UnixFileMode Readable =
        UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead | UnixFileMode.OtherRead;

    public string Name => "dnf";

    public async Task<IReadOnlyList<UpgradablePackage>> ListUpgradableAsync(CancellationToken cancellationToken)
    {
        var all = await CheckUpdateAsync(security: false, cancellationToken);
        var security = await CheckUpdateAsync(security: true, cancellationToken);
        return DnfOutput.MarkSecurity(all, security);
    }

    public Task RefreshIndexAsync(JobContext job, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(job);
        job.Log("Refreshing the package metadata (dnf makecache).");
        return RunAsync(job, "refresh", "Refresh the package metadata", ["-y", "makecache", "--refresh"], TimeSpan.FromMinutes(10), cancellationToken);
    }

    public async Task UpgradeAsync(bool securityOnly, JobContext job, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(job);
        await RefreshIndexAsync(job, cancellationToken);
        if (securityOnly)
        {
            job.Log("Installing security updates (dnf upgrade --security).");
            await RunAsync(job, "upgrade", "Install security updates", ["-y", "upgrade", "--security"], TimeSpan.FromHours(1), cancellationToken);
        }
        else
        {
            job.Log("Upgrading every package (dnf upgrade).");
            await RunAsync(job, "upgrade", "Upgrade all packages", ["-y", "upgrade"], TimeSpan.FromHours(1), cancellationToken);
        }
    }

    public async Task<AutoUpdatesInfo> GetAutomaticUpdatesAsync(CancellationToken cancellationToken)
    {
        var installed = await IsInstalledAsync(cancellationToken);
        var enabled = false;
        if (installed)
        {
            var timer = await RunPlainAsync("systemctl", ["is-enabled", Timer], cancellationToken);
            var apply = IniFile.Get(files.ReadText(AutomaticConfPath) ?? string.Empty, "commands", "apply_updates");
            enabled = timer.StandardOutput.Trim() == "enabled" && apply is "yes" or "true" or "1";
        }

        return new AutoUpdatesInfo(Supported: true, installed, enabled, "dnf-automatic");
    }

    public async Task SetAutomaticUpdatesAsync(bool enabled, JobContext job, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(job);
        var installed = await IsInstalledAsync(cancellationToken);
        if (!enabled)
        {
            if (!installed)
            {
                job.Log("dnf-automatic is not installed, so automatic updates are already off.");
                return;
            }

            await SystemctlAsync(job, ["disable", "--now", Timer], cancellationToken);
            job.Log("Automatic security updates are off.");
            return;
        }

        if (!installed)
        {
            job.Log("Installing dnf-automatic.");
            await RunAsync(job, "install", "Install dnf-automatic", ["-y", "install", "dnf-automatic"], TimeSpan.FromMinutes(30), cancellationToken);
        }

        var conf = files.ReadText(AutomaticConfPath) ?? string.Empty;
        conf = IniFile.Set(conf, "commands", "upgrade_type", "security");
        conf = IniFile.Set(conf, "commands", "apply_updates", "yes");
        files.WriteText(AutomaticConfPath, conf, Readable);
        await SystemctlAsync(job, ["enable", "--now", Timer], cancellationToken);
        job.Log("Automatic security updates are on: dnf-automatic installs them when its timer fires.");
    }

    /// <summary>
    /// needs-restarting (dnf-plugins-core) knows best. Minimal images may not have it; then a newer
    /// kernel than the running one is the sign.
    /// </summary>
    public async Task<RebootStatus> GetRebootStatusAsync(CancellationToken cancellationToken)
    {
        if (files.Exists(NeedsRestarting))
        {
            var check = await RunPlainAsync(NeedsRestarting, ["-r"], cancellationToken);
            return check.ExitCode switch
            {
                0 => new RebootStatus(false, []),
                1 => new RebootStatus(true, []),
                _ => new RebootStatus(null, []),
            };
        }

        var running = files.ReadText("/proc/sys/kernel/osrelease")?.Trim();
        var kernels = await RunPlainAsync("rpm", ["-q", "--last", "kernel-core"], cancellationToken);
        var newest = kernels.StandardOutput.Split('\n', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .Select(line => line.Split(' ', StringSplitOptions.RemoveEmptyEntries)[0])
            .FirstOrDefault(package => package.StartsWith("kernel-core-", StringComparison.Ordinal));
        if (!kernels.Succeeded || string.IsNullOrEmpty(running) || newest is null)
        {
            return new RebootStatus(null, []);
        }

        return newest["kernel-core-".Length..] == running
            ? new RebootStatus(false, [])
            : new RebootStatus(true, [newest]);
    }

    private async Task<IReadOnlyList<UpgradablePackage>> CheckUpdateAsync(bool security, CancellationToken cancellationToken)
    {
        string[] arguments = security ? ["-q", "check-update", "--security"] : ["-q", "check-update"];
        var result = await runner.RunAsync(
            new ProcessSpec { Program = "dnf", Arguments = arguments, Timeout = TimeSpan.FromMinutes(5), MaxOutputBytes = 4 * 1024 * 1024 },
            onLine: null,
            cancellationToken);
        // 100 means "there are updates"; 0 means none; anything else is an error.
        if (result.TimedOut || result.ExitCode is not (0 or 100))
        {
            var reason = result.StandardError.Split('\n', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries).FirstOrDefault()
                ?? $"exit code {result.ExitCode}";
            throw new ProcessFailedException($"dnf check-update failed: {reason}");
        }

        return DnfOutput.ParseCheckUpdate(result.StandardOutput);
    }

    private async Task<bool> IsInstalledAsync(CancellationToken cancellationToken) =>
        (await RunPlainAsync("rpm", ["-q", "dnf-automatic"], cancellationToken)).ExitCode == 0;

    private Task<ProcessResult> RunPlainAsync(string program, string[] arguments, CancellationToken cancellationToken) =>
        runner.RunAsync(
            new ProcessSpec { Program = program, Arguments = arguments, Timeout = TimeSpan.FromMinutes(1) },
            onLine: null,
            cancellationToken);

    private async Task SystemctlAsync(JobContext job, string[] arguments, CancellationToken cancellationToken)
    {
        var result = await RunPlainAsync("systemctl", arguments, cancellationToken);
        job.ExitCode = result.ExitCode;
        if (!result.Succeeded)
        {
            throw new JobFailedException($"systemctl {string.Join(' ', arguments)} failed: {result.StandardError.Trim()}", result.ExitCode);
        }
    }

    private async Task RunAsync(
        JobContext job,
        string step,
        string description,
        string[] arguments,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        var result = await units.RunAsync(
            job.UnitFor(step),
            description,
            new ProcessSpec { Program = Dnf, Arguments = arguments, Timeout = timeout, MaxOutputBytes = 256 * 1024 },
            job.Output,
            cancellationToken);
        job.ExitCode = result.ExitCode;
        if (result.TimedOut)
        {
            throw new JobFailedException($"dnf did not finish within {timeout.TotalMinutes:0} minutes and was stopped.");
        }

        if (!result.Succeeded)
        {
            throw new JobFailedException($"dnf exited with code {result.ExitCode}. The log shows why.", result.ExitCode);
        }
    }
}

/// <summary>A system whose package manager the core does not know: nothing to list, nothing it can do.</summary>
internal sealed class UnsupportedPackageManager : IPackageManager
{
    private const string Refusal = "The core does not know this server's package manager.";

    public string Name => "none";

    public Task<IReadOnlyList<UpgradablePackage>> ListUpgradableAsync(CancellationToken cancellationToken) =>
        Task.FromResult<IReadOnlyList<UpgradablePackage>>([]);

    public Task RefreshIndexAsync(JobContext job, CancellationToken cancellationToken) => throw new JobFailedException(Refusal);

    public Task UpgradeAsync(bool securityOnly, JobContext job, CancellationToken cancellationToken) => throw new JobFailedException(Refusal);

    public Task<AutoUpdatesInfo> GetAutomaticUpdatesAsync(CancellationToken cancellationToken) =>
        Task.FromResult(new AutoUpdatesInfo(Supported: false, Installed: false, Enabled: false, "none"));

    public Task SetAutomaticUpdatesAsync(bool enabled, JobContext job, CancellationToken cancellationToken) =>
        throw new JobFailedException(Refusal);

    public Task<RebootStatus> GetRebootStatusAsync(CancellationToken cancellationToken) =>
        Task.FromResult(new RebootStatus(null, []));
}
