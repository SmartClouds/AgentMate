using System.Globalization;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Platform;

namespace Runova.ServerCore.Alerts;

/// <summary>
/// Raises the alerts nobody asks for: a filesystem filling up (checked every minute) and a reboot
/// that installed updates are waiting for (every five minutes). An alert is only touched when what
/// it says changes, so a full disk does not send the app a change every minute.
/// </summary>
internal sealed partial class AlertMonitor(
    ISystemProbe probe,
    IPackageManager packages,
    AlertCenter alerts,
    ILogger<AlertMonitor> logger) : BackgroundService
{
    public const double WarningPercent = 90;

    public const double CriticalPercent = 95;

    /// <summary>Below this an open disk alert resolves. The gap to the warning keeps it from flapping.</summary>
    public const double ClearPercent = 85;

    public const string RebootResource = "system";

    private static readonly TimeSpan _every = TimeSpan.FromMinutes(1);

    private const int RebootEveryTicks = 5;

    public async Task CheckDisksAsync(CancellationToken cancellationToken)
    {
        var disks = probe.ReadFilesystems();
        var open = (await alerts.OpenAsync(AlertKind.DiskPressure, cancellationToken)).ToDictionary(a => a.Resource, StringComparer.Ordinal);
        foreach (var disk in disks.Where(d => d.TotalBytes > 0))
        {
            var percent = 100.0 * disk.UsedBytes / disk.TotalBytes;
            open.TryGetValue(disk.MountPoint, out var current);
            if (percent >= WarningPercent)
            {
                var severity = percent >= CriticalPercent ? AlertSeverity.Critical : AlertSeverity.Warning;
                var message = string.Create(
                    CultureInfo.InvariantCulture,
                    $"{disk.MountPoint} is {Math.Floor(percent):0}% full: {Bytes(disk.AvailableBytes)} of {Bytes(disk.TotalBytes)} left.");
                if (current is null || current.Severity != severity || current.Message != message)
                {
                    await alerts.RaiseAsync(AlertKind.DiskPressure, disk.MountPoint, severity, message, cancellationToken);
                }
            }
            else if (percent < ClearPercent && current is not null)
            {
                await alerts.ResolveAsync(AlertKind.DiskPressure, disk.MountPoint, cancellationToken);
            }
        }

        // A filesystem that is no longer mounted is no longer filling up.
        var mounted = disks.Select(d => d.MountPoint).ToHashSet(StringComparer.Ordinal);
        foreach (var gone in open.Keys.Where(resource => !mounted.Contains(resource)))
        {
            await alerts.ResolveAsync(AlertKind.DiskPressure, gone, cancellationToken);
        }
    }

    public async Task CheckRebootAsync(CancellationToken cancellationToken)
    {
        var status = await packages.GetRebootStatusAsync(cancellationToken);
        if (status.Required == true)
        {
            var message = status.Packages.Count > 0
                ? $"A reboot is needed to finish installing updates ({string.Join(", ", status.Packages)})."
                : "A reboot is needed to finish installing updates.";
            var open = await alerts.OpenAsync(AlertKind.RebootRequired, cancellationToken);
            if (!open.Any(alert => alert.Message == message))
            {
                await alerts.RaiseAsync(AlertKind.RebootRequired, RebootResource, AlertSeverity.Warning, message, cancellationToken);
            }
        }
        else if (status.Required == false)
        {
            await alerts.ResolveAsync(AlertKind.RebootRequired, RebootResource, cancellationToken);
        }
    }

    /// <remarks>Paced in real time, as the metrics sampler is, so a test clock moved by months replays nothing.</remarks>
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(_every, TimeProvider.System);
        var tick = 0;
        do
        {
            await RunSafelyAsync(CheckDisksAsync, stoppingToken);
            if (tick++ % RebootEveryTicks == 0)
            {
                await RunSafelyAsync(CheckRebootAsync, stoppingToken);
            }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    private async Task RunSafelyAsync(Func<CancellationToken, Task> check, CancellationToken stoppingToken)
    {
        try
        {
            await check(stoppingToken);
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            LogCheckFailed(logger, error);
        }
    }

    private static string Bytes(long bytes)
    {
        string[] units = ["B", "KB", "MB", "GB", "TB", "PB"];
        double value = bytes;
        var unit = 0;
        while (value >= 1024 && unit < units.Length - 1)
        {
            value /= 1024;
            unit++;
        }

        return string.Create(CultureInfo.InvariantCulture, $"{value:0.#} {units[unit]}");
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "An alert check failed; it runs again at the next tick.")]
    private static partial void LogCheckFailed(ILogger logger, Exception error);
}

/// <summary>Once a day: finished jobs, their logs and resolved alerts older than 30 days go.</summary>
internal sealed partial class CoreMaintenance(
    Jobs.JobEngine jobs,
    AlertCenter alerts,
    TimeProvider time,
    ILogger<CoreMaintenance> logger) : BackgroundService
{
    private static readonly TimeSpan _every = TimeSpan.FromDays(1);

    public async Task<(int Jobs, int Alerts)> RunOnceAsync(CancellationToken cancellationToken)
    {
        var now = time.GetUtcNow();
        return (
            await jobs.PruneAsync(now - Jobs.JobEngine.Keep, cancellationToken),
            await alerts.PruneAsync(now - AlertCenter.KeepResolved, cancellationToken));
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(_every, time);
        do
        {
            try
            {
                var (prunedJobs, prunedAlerts) = await RunOnceAsync(stoppingToken);
                if (prunedJobs + prunedAlerts > 0)
                {
                    LogPruned(logger, prunedJobs, prunedAlerts);
                }
            }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                LogFailed(logger, error);
            }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Pruned {Jobs} old jobs and {Alerts} old alerts.")]
    private static partial void LogPruned(ILogger logger, int jobs, int alerts);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Pruning old jobs and alerts failed; it is tried again tomorrow.")]
    private static partial void LogFailed(ILogger logger, Exception error);
}
