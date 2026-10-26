using Runova.ServerCore.Compatibility;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Hosting;
using Runova.ServerCore.Jobs;

namespace Runova.ServerCore.Platform;

/// <summary>
/// apt on Ubuntu and Debian. Everything that changes the system runs in a transient unit and
/// never waits for a person: noninteractive frontends, needrestart restarting services by itself,
/// changed configuration files kept as they are, and a lock timeout instead of an instant failure
/// when unattended-upgrades happens to hold the dpkg lock.
/// </summary>
internal sealed class AptPackageManager(IProcessRunner runner, SystemdRunner units, ISystemFiles files) : IPackageManager
{
    public const string AutoUpgradesPath = "/etc/apt/apt.conf.d/20auto-upgrades";

    public const string NeedrestartDirectory = "/etc/needrestart/conf.d";

    public static string NeedrestartOverridePath => CoreLayout.Current.NeedrestartOverridePath;

    private const string AptGet = "/usr/bin/apt-get";

    private const UnixFileMode Readable =
        UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead | UnixFileMode.OtherRead;

    /// <summary>
    /// needrestart runs at the end of an apt run and, in automatic mode, restarts every service still
    /// using an old library. The core must not be one of them: it is the one running the upgrade.
    /// </summary>
    /// <remarks>Both unit names, so the rule holds on either layout and through a migration.</remarks>
    public static readonly string NeedrestartOverride = $$"""
        # Written by Runova. needrestart may restart services after an upgrade, but never the
        # Runova core, which runs the upgrade and records how it went.
        $nrconf{override_rc}{qr(^(?:{{CoreLayout.Runova.Unit}}|{{LegacyNames.Unit}})\.service$)} = 0;

        """;

    private static readonly string[] _options =
    [
        "-q", "-y", "-o", "DPkg::Lock::Timeout=300", "-o", "Dpkg::Options::=--force-confdef", "-o", "Dpkg::Options::=--force-confold",
    ];

    private static readonly Dictionary<string, string> _environment = new(StringComparer.Ordinal)
    {
        ["DEBIAN_FRONTEND"] = "noninteractive",
        ["NEEDRESTART_MODE"] = "a",
        ["APT_LISTCHANGES_FRONTEND"] = "none",
        ["UCF_FORCE_CONFFOLD"] = "1",
    };

    public string Name => "apt";

    public async Task<IReadOnlyList<UpgradablePackage>> ListUpgradableAsync(CancellationToken cancellationToken)
    {
        var result = await runner.RunAsync(
            new ProcessSpec { Program = "apt", Arguments = ["list", "--upgradable"], Timeout = TimeSpan.FromMinutes(2), MaxOutputBytes = 4 * 1024 * 1024 },
            onLine: null,
            cancellationToken);
        if (!result.Succeeded)
        {
            throw new ProcessFailedException($"apt list failed: {FirstLine(result.StandardError) ?? $"exit code {result.ExitCode}"}");
        }

        return AptOutput.ParseUpgradable(result.StandardOutput);
    }

    public Task RefreshIndexAsync(JobContext job, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(job);
        job.Log("Refreshing the package index (apt-get update).");
        return RunAsync(job, "refresh", "Refresh the package index", [.. _options, "update"], TimeSpan.FromMinutes(10), cancellationToken);
    }

    public async Task UpgradeAsync(bool securityOnly, JobContext job, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(job);
        KeepCoreRunning();
        await RefreshIndexAsync(job, cancellationToken);
        if (!securityOnly)
        {
            job.Log("Upgrading every package (apt-get upgrade --with-new-pkgs).");
            await RunAsync(job, "upgrade", "Upgrade all packages", [.. _options, "--with-new-pkgs", "upgrade"], TimeSpan.FromHours(1), cancellationToken);
            return;
        }

        var security = (await ListUpgradableAsync(cancellationToken))
            .Where(package => package.Security && PackageNames.IsValid(package.Name))
            .Select(package => package.Name)
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .ToList();
        if (security.Count == 0)
        {
            job.Log("No security updates are waiting.");
            return;
        }

        job.Log($"Installing security updates for {security.Count} packages: {string.Join(", ", security)}.");
        await RunAsync(
            job,
            "upgrade",
            "Install security updates",
            [.. _options, "--only-upgrade", "install", .. security],
            TimeSpan.FromHours(1),
            cancellationToken);
    }

    public async Task<AutoUpdatesInfo> GetAutomaticUpdatesAsync(CancellationToken cancellationToken)
    {
        var installed = await IsInstalledAsync(cancellationToken);
        var dump = await runner.RunAsync(
            new ProcessSpec { Program = "apt-config", Arguments = ["dump"], Timeout = TimeSpan.FromSeconds(30) },
            onLine: null,
            cancellationToken);
        var lists = Periodic(dump.StandardOutput, "APT::Periodic::Update-Package-Lists");
        var upgrade = Periodic(dump.StandardOutput, "APT::Periodic::Unattended-Upgrade");
        var enabled = installed && IsOn(lists) && IsOn(upgrade);
        return new AutoUpdatesInfo(Supported: true, installed, enabled, "unattended-upgrades");
    }

    public async Task SetAutomaticUpdatesAsync(bool enabled, JobContext job, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(job);
        if (enabled && !await IsInstalledAsync(cancellationToken))
        {
            job.Log("Installing unattended-upgrades.");
            KeepCoreRunning();
            await RunAsync(job, "install", "Install unattended-upgrades", [.. _options, "install", "unattended-upgrades"], TimeSpan.FromMinutes(30), cancellationToken);
        }

        var value = enabled ? "1" : "0";
        files.WriteText(
            AutoUpgradesPath,
            $"""
            // Written by Runova: automatic security updates are {(enabled ? "on" : "off")}.
            APT::Periodic::Update-Package-Lists "{value}";
            APT::Periodic::Unattended-Upgrade "{value}";

            """,
            Readable);
        job.Log(enabled
            ? "Automatic security updates are on: unattended-upgrades installs them every day."
            : "Automatic security updates are off.");
    }

    public Task<RebootStatus> GetRebootStatusAsync(CancellationToken cancellationToken)
    {
        // Packages that need a reboot (a kernel, libc) leave this file behind; the .pkgs file names them.
        if (!files.Exists("/run/reboot-required"))
        {
            return Task.FromResult(new RebootStatus(false, []));
        }

        var packages = (files.ReadText("/run/reboot-required.pkgs") ?? string.Empty)
            .Split('\n', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .Where(PackageNames.IsValid)
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        return Task.FromResult(new RebootStatus(true, packages));
    }

    private async Task<bool> IsInstalledAsync(CancellationToken cancellationToken)
    {
        var query = await runner.RunAsync(
            new ProcessSpec { Program = "dpkg-query", Arguments = ["-W", "--showformat=${Status}", "unattended-upgrades"], Timeout = TimeSpan.FromSeconds(30) },
            onLine: null,
            cancellationToken);
        return query.Succeeded && query.StandardOutput.Contains("install ok installed", StringComparison.Ordinal);
    }

    private void KeepCoreRunning()
    {
        if (files.Exists(NeedrestartDirectory))
        {
            files.WriteText(NeedrestartOverridePath, NeedrestartOverride, Readable);
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
            new ProcessSpec
            {
                Program = AptGet,
                Arguments = arguments,
                Environment = _environment,
                Timeout = timeout,
                MaxOutputBytes = 256 * 1024,
            },
            job.Output,
            cancellationToken);
        job.ExitCode = result.ExitCode;
        if (result.TimedOut)
        {
            throw new JobFailedException($"apt-get did not finish within {timeout.TotalMinutes:0} minutes and was stopped.");
        }

        if (!result.Succeeded)
        {
            throw new JobFailedException($"apt-get exited with code {result.ExitCode}. The log shows why.", result.ExitCode);
        }
    }

    /// <summary>`APT::Periodic::Unattended-Upgrade "1";` from apt-config dump; null when unset.</summary>
    private static string? Periodic(string dump, string key)
    {
        foreach (var line in dump.Split('\n', StringSplitOptions.TrimEntries))
        {
            if (line.StartsWith(key + " ", StringComparison.Ordinal))
            {
                return line[(key.Length + 1)..].Trim().TrimEnd(';').Trim('"');
            }
        }

        return null;
    }

    private static bool IsOn(string? value) => value is { Length: > 0 } and not "0" and not "false";

    private static string? FirstLine(string text) =>
        text.Split('\n', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .FirstOrDefault(line => !line.StartsWith("WARNING: apt does not have a stable CLI", StringComparison.Ordinal));
}
