namespace Runova.ServerCore.Audit;

/// <summary>
/// Keeps a year of audit events: once a day, older ones are pruned. The chain's anchor records
/// where it continues, so what is left still verifies.
/// </summary>
internal sealed partial class AuditRetention(AuditLog audit, TimeProvider time, ILogger<AuditRetention> logger)
    : BackgroundService
{
    public static readonly TimeSpan Keep = TimeSpan.FromDays(365);

    private static readonly TimeSpan _every = TimeSpan.FromDays(1);

    public async Task<int> RunOnceAsync(CancellationToken cancellationToken) =>
        await audit.PruneAsync(time.GetUtcNow() - Keep, cancellationToken);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(_every, time);
        do
        {
            try
            {
                var pruned = await RunOnceAsync(stoppingToken);
                if (pruned > 0)
                {
                    LogPruned(logger, pruned);
                }
            }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                LogFailed(logger, error);
            }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Pruned {Count} audit events older than a year.")]
    private static partial void LogPruned(ILogger logger, int count);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Pruning the audit trail failed; it is tried again tomorrow.")]
    private static partial void LogFailed(ILogger logger, Exception error);
}
