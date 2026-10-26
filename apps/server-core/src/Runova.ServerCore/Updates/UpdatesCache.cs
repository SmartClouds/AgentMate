using Runova.ServerCore.Contracts;
using Runova.ServerCore.Platform;

namespace Runova.ServerCore.Updates;

/// <summary>
/// What is waiting to be upgraded, as of the last check. Reading it never starts a program: the
/// list is refreshed here, shortly after the core starts, every hour, and at the end of every
/// package job. A check that fails keeps the last list and says why.
/// </summary>
internal sealed partial class UpdatesCache(IPackageManager packages, TimeProvider time, ILogger<UpdatesCache> logger)
    : BackgroundService
{
    public static readonly TimeSpan RefreshEvery = TimeSpan.FromHours(1);

    /// <summary>Long enough for the core to start and answer first.</summary>
    public static readonly TimeSpan FirstRefreshAfter = TimeSpan.FromSeconds(20);

    private readonly SemaphoreSlim _refreshing = new(1, 1);
    private readonly Lock _gate = new();
    private UpdatesInfo? _current;

    public UpdatesInfo Current
    {
        get
        {
            lock (_gate)
            {
                return _current ?? new UpdatesInfo(
                    packages.Name,
                    [],
                    0,
                    new AutoUpdatesInfo(Supported: packages.Name != "none", Installed: false, Enabled: false, "unknown"));
            }
        }
    }

    /// <summary>
    /// Checks now. Checks run one at a time, and a caller always gets one that started after it
    /// asked: a check begun before an upgrade ended would still list what it upgraded.
    /// </summary>
    public async Task<UpdatesInfo> RefreshAsync(CancellationToken cancellationToken)
    {
        await _refreshing.WaitAsync(cancellationToken);
        try
        {
            var updated = await CheckAsync(Current, cancellationToken);
            lock (_gate)
            {
                _current = updated;
            }

            return updated;
        }
        finally
        {
            _refreshing.Release();
        }
    }

    public override void Dispose()
    {
        base.Dispose();
        _refreshing.Dispose();
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await Task.Delay(FirstRefreshAfter, time, stoppingToken);
        using var timer = new PeriodicTimer(RefreshEvery, time);
        do
        {
            try
            {
                await RefreshAsync(stoppingToken);
            }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                LogFailed(logger, error);
            }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    private async Task<UpdatesInfo> CheckAsync(UpdatesInfo previous, CancellationToken cancellationToken)
    {
        UpgradablePackage[] list;
        string? error = null;
        try
        {
            list = [.. await packages.ListUpgradableAsync(cancellationToken)];
        }
        catch (Exception failure) when (failure is not OperationCanceledException)
        {
            list = previous.Packages;
            error = failure.Message;
        }

        var automatic = await packages.GetAutomaticUpdatesAsync(cancellationToken);
        var reboot = await packages.GetRebootStatusAsync(cancellationToken);
        return new UpdatesInfo(
            packages.Name,
            list,
            list.Count(package => package.Security),
            automatic,
            time.GetUtcNow().ToUnixTimeMilliseconds(),
            reboot.Required,
            error);
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "Checking for package updates failed; it is tried again in an hour.")]
    private static partial void LogFailed(ILogger logger, Exception error);
}
