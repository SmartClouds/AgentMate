using Runova.ServerCore.Contracts;
using Runova.ServerCore.Jobs;
using Runova.ServerCore.Platform;

namespace Runova.ServerCore.Updates;

/// <summary>Who asked, for the job and its log.</summary>
internal readonly record struct Requester(Guid UserId, string UserName);

/// <summary>
/// Starts the jobs behind the Overview's buttons. Package work holds the "packages" lock, so two
/// package jobs never run at once, and a reboot also holds "power", so it cannot start in the
/// middle of an upgrade.
/// </summary>
internal sealed class SystemJobs(
    JobEngine jobs,
    IPackageManager packages,
    IServiceManager services,
    IPowerControl power,
    UpdatesCache updates)
{
    public const string PackagesLock = "packages";

    public const string PowerLock = "power";

    /// <summary>Between the job's success and the reboot: long enough for the app to hear it.</summary>
    public static readonly TimeSpan RebootDelay = TimeSpan.FromSeconds(5);

    public Task<JobInfo> CheckForUpdatesAsync(Requester who, CancellationToken cancellationToken) =>
        StartPackageJobAsync(JobKind.PackagesRefresh, "Check for updates", who, (job, token) => packages.RefreshIndexAsync(job, token), cancellationToken);

    public Task<JobInfo> UpgradeAsync(bool securityOnly, Requester who, CancellationToken cancellationToken) =>
        StartPackageJobAsync(
            securityOnly ? JobKind.PackagesUpgradeSecurity : JobKind.PackagesUpgrade,
            securityOnly ? "Install security updates" : "Upgrade all packages",
            who,
            (job, token) => packages.UpgradeAsync(securityOnly, job, token),
            cancellationToken);

    public Task<JobInfo> SetAutomaticUpdatesAsync(bool enabled, Requester who, CancellationToken cancellationToken) =>
        StartPackageJobAsync(
            JobKind.AutomaticUpdates,
            enabled ? "Turn on automatic security updates" : "Turn off automatic security updates",
            who,
            (job, token) => packages.SetAutomaticUpdatesAsync(enabled, job, token),
            cancellationToken);

    /// <summary>
    /// Schedules the reboot from a transient timer and ends the job right after, so its success is
    /// on record before the machine goes down. It cannot be cancelled: once scheduled, it happens.
    /// </summary>
    public Task<JobInfo> RebootAsync(Requester who, CancellationToken cancellationToken) =>
        jobs.StartAsync(
            new JobRequest(JobKind.Reboot, "Reboot the server", [PowerLock, PackagesLock], "server", who.UserId, who.UserName, Cancellable: false),
            async (job, token) =>
            {
                job.Log($"The server reboots in {RebootDelay.TotalSeconds:0} seconds. The app reconnects by itself once it is back.");
                await power.ScheduleRebootAsync(job, RebootDelay, token);
            },
            cancellationToken);

    public Task<JobInfo> RestartAsync(ManagedService service, Requester who, CancellationToken cancellationToken)
    {
        if (!Enum.IsDefined(service))
        {
            throw new ArgumentOutOfRangeException(nameof(service), "Only Docker and nginx can be restarted from the app.");
        }

        var name = service == ManagedService.Docker ? "docker" : "nginx";
        return jobs.StartAsync(
            new JobRequest(
                JobKind.ServiceRestart,
                service == ManagedService.Docker ? "Restart Docker" : "Restart nginx",
                [$"service:{name}"],
                name,
                who.UserId,
                who.UserName),
            (job, token) => services.RestartAsync(service, job, token),
            cancellationToken);
    }

    /// <summary>A package job, after which the list of updates is checked again, whatever happened.</summary>
    private Task<JobInfo> StartPackageJobAsync(
        JobKind kind,
        string title,
        Requester who,
        JobWork work,
        CancellationToken cancellationToken) =>
        jobs.StartAsync(
            new JobRequest(kind, title, [PackagesLock], "packages", who.UserId, who.UserName),
            async (job, token) =>
            {
                try
                {
                    await work(job, token);
                }
                finally
                {
                    job.Log("Checking what is left to upgrade.");
                    await updates.RefreshAsync(CancellationToken.None);
                }
            },
            cancellationToken);
}
