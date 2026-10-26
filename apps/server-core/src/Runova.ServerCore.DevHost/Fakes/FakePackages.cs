using Runova.ServerCore.Contracts;
using Runova.ServerCore.Jobs;
using Runova.ServerCore.Platform;

namespace Runova.ServerCore.DevHost.Fakes;

/// <summary>
/// apt, pretended: the log shows what apt would print, a few lines a second, so the live log and
/// cancellation can be tried; nothing is installed anywhere.
/// </summary>
internal sealed class FakePackages(FakeServer server, TimeProvider time) : IPackageManager
{
    private static readonly TimeSpan _line = TimeSpan.FromMilliseconds(180);

    public string Name => "apt";

    public Task<IReadOnlyList<UpgradablePackage>> ListUpgradableAsync(CancellationToken cancellationToken) =>
        Task.FromResult(server.Packages);

    public async Task RefreshIndexAsync(JobContext job, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(job);
        string[] lines =
        [
            "Hit:1 http://archive.ubuntu.com/ubuntu noble InRelease",
            "Get:2 http://archive.ubuntu.com/ubuntu noble-updates InRelease [126 kB]",
            "Get:3 http://security.ubuntu.com/ubuntu noble-security InRelease [126 kB]",
            "Hit:4 https://download.docker.com/linux/ubuntu noble InRelease",
            "Fetched 252 kB in 1s (310 kB/s)",
            "Reading package lists...",
        ];
        await EmitAsync(job, lines, cancellationToken);
    }

    public async Task UpgradeAsync(bool securityOnly, JobContext job, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(job);
        await RefreshIndexAsync(job, cancellationToken);
        var chosen = server.Packages.Where(package => !securityOnly || package.Security).ToList();
        if (chosen.Count == 0)
        {
            job.Log(securityOnly ? "No security updates are waiting." : "Nothing to upgrade.");
            return;
        }

        await EmitAsync(job, ["Reading package lists...", "Building dependency tree...", "Reading state information..."], cancellationToken);
        job.Log($"{chosen.Count} upgraded, 0 newly installed, 0 to remove and 0 not upgraded.", JobLogSource.Out);
        var number = 1;
        foreach (var package in chosen)
        {
            await EmitAsync(
                job,
                [$"Get:{number++} http://archive.ubuntu.com/ubuntu noble-updates/main {package.Architecture} {package.Name} {package.NewVersion} [1,204 kB]"],
                cancellationToken);
        }

        foreach (var package in chosen)
        {
            await EmitAsync(
                job,
                [
                    $"Preparing to unpack .../{package.Name}_{package.NewVersion}_{package.Architecture}.deb ...",
                    $"Unpacking {package.Name}:{package.Architecture} ({package.NewVersion}) over ({package.CurrentVersion}) ...",
                ],
                cancellationToken);
        }

        foreach (var package in chosen)
        {
            await EmitAsync(job, [$"Setting up {package.Name}:{package.Architecture} ({package.NewVersion}) ..."], cancellationToken);
        }

        server.Upgraded(chosen.Select(package => package.Name));
        if (server.RebootRequired)
        {
            job.Log("*** System restart required ***", JobLogSource.Out);
        }
    }

    public Task<AutoUpdatesInfo> GetAutomaticUpdatesAsync(CancellationToken cancellationToken) =>
        Task.FromResult(new AutoUpdatesInfo(Supported: true, Installed: true, server.AutomaticUpdates, "unattended-upgrades"));

    public async Task SetAutomaticUpdatesAsync(bool enabled, JobContext job, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(job);
        await EmitAsync(job, [$"Writing /etc/apt/apt.conf.d/20auto-upgrades (Unattended-Upgrade \"{(enabled ? 1 : 0)}\")."], cancellationToken);
        server.SetAutomaticUpdates(enabled);
    }

    public Task<RebootStatus> GetRebootStatusAsync(CancellationToken cancellationToken) =>
        Task.FromResult(server.RebootRequired
            ? new RebootStatus(true, ["linux-image-6.8.0-47-generic"])
            : new RebootStatus(false, []));

    private async Task EmitAsync(JobContext job, string[] lines, CancellationToken cancellationToken)
    {
        foreach (var line in lines)
        {
            await Task.Delay(_line, time, cancellationToken);
            job.Log(line, JobLogSource.Out);
        }
    }
}
