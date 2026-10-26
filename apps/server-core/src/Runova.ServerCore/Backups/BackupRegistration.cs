using Hangfire;
using Hangfire.Storage.SQLite;
using Microsoft.EntityFrameworkCore;
using Runova.ServerCore.Backups.Destinations;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Docker;
using Runova.ServerCore.Hosting;

namespace Runova.ServerCore.Backups;

/// <summary>Puts the plans back on Hangfire's schedule at start, before its server picks up any job.</summary>
internal sealed partial class BackupScheduleStartup(IServiceProvider services, BackupPlanScheduler scheduler, ILogger<BackupScheduleStartup> logger) : IHostedService
{
    public async Task StartAsync(CancellationToken cancellationToken)
    {
        await using var scope = services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<CoreDbContext>();
        var plans = await db.BackupPlans.AsNoTracking().ToListAsync(cancellationToken);
        scheduler.Reconcile(plans);

        // A run the core stopped in the middle of is over: its job does not come back.
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        await db.BackupRunTargets
            .Where(t => t.State == BackupTargetState.Pending || t.State == BackupTargetState.Uploading)
            .Where(t => db.BackupRuns.Any(r => r.Id == t.RunId && r.State == BackupRunState.Running))
            .ExecuteUpdateAsync(set => set.SetProperty(t => t.State, BackupTargetState.Failed).SetProperty(t => t.Error, "The core stopped during the upload."), cancellationToken);
        await db.BackupRuns
            .Where(r => r.State == BackupRunState.Running)
            .ExecuteUpdateAsync(set => set.SetProperty(r => r.State, BackupRunState.Failed).SetProperty(r => r.FinishedAt, now).SetProperty(r => r.Error, "The core stopped while the backup ran."), cancellationToken);
        LogScheduled(logger, plans.Count);
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    [LoggerMessage(Level = LogLevel.Information, Message = "Backup plans reconciled with the schedule: {Count}.")]
    private static partial void LogScheduled(ILogger logger, int count);
}

/// <summary>What the hub's server backup methods use beyond the settings, in one place.</summary>
internal sealed record BackupOperations(
    BackupDestinationTester Tester,
    StoredBackups Stored,
    TelegramLogins Telegram,
    BackupFetcher Fetcher,
    ServerRestorer Restorer,
    IBackgroundJobClient Jobs,
    IServiceProvider Services)
{
    /// <summary>A runner for this call; Hangfire builds its own for each job.</summary>
    public BackupRunner Runner => Services.GetRequiredService<BackupRunner>();
}

internal static class BackupRegistration
{
    public const string Queue = "backups";
    public const string StorageFile = "hangfire.db";

    /// <summary>
    /// Hangfire (E28) in its own SQLite file in the state folder, apart from core.db so a restore's
    /// swap and VACUUM INTO never carry it. Call after the database's startup service: the plans are
    /// reconciled before the Hangfire server starts, and both need the database.
    /// </summary>
    public static IServiceCollection AddCoreBackups(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);

        services.AddSingleton<JobStorage>(provider =>
        {
            var directories = provider.GetRequiredService<CoreDirectories>();
            Directory.CreateDirectory(directories.Data);
            // Polled every two seconds, so "back up now" starts at once; one small query on a local file.
            return new SQLiteStorage(Path.Combine(directories.Data, StorageFile), new SQLiteStorageOptions { QueuePollInterval = TimeSpan.FromSeconds(2) });
        });
        services.AddHangfire((provider, configuration) => configuration
            .SetDataCompatibilityLevel(CompatibilityLevel.Version_180)
            .UseSimpleAssemblyNameTypeSerializer()
            .UseRecommendedSerializerSettings()
            .UseLogProvider(new HangfireLogs(provider.GetRequiredService<ILoggerFactory>()))
            .UseStorage(provider.GetRequiredService<JobStorage>()));
        services.AddSingleton<BackupPlanScheduler>();
        services.AddSingleton<BackupCenter>();
        services.AddSingleton<IBackupDestinationFactory, BackupDestinationFactory>();
        services.AddHttpClient(CloudDestinations.HttpClientName, client => client.Timeout = TimeSpan.FromMinutes(30));
        services.AddSingleton<IExtraBackupDestinations, CloudDestinations>();
        services.AddSingleton<ITelegramConnector, WTelegramConnector>();
        services.AddSingleton<TelegramLogins>();
        services.AddSingleton<IExtraBackupDestinations, TelegramDestinations>();
        services.AddSingleton<BackupDestinationTester>();
        services.AddSingleton<IBackupDocker>(provider => new DockerBackupEngine(
            new Uri(provider.GetRequiredService<IConfiguration>()["Core:Docker:Endpoint"] ?? DockerEngine.DefaultEndpoint)));
        services.AddSingleton<IServerStateReader, ServerStateReader>();
        services.AddSingleton(FullBackupOptions.Default);
        services.AddSingleton<FullBackupComposer>();
        services.AddSingleton<IBackupJobQueue, HangfireBackupQueue>();
        services.AddSingleton<BackupRunGate>();
        services.AddTransient<BackupRunner>();
        services.AddSingleton<StoredBackups>();
        services.AddSingleton<BackupFetcher>();
        services.AddSingleton<ICloudflareRecords, CloudflareRecords>();
        services.AddSingleton<IAddressRebinder, AddressRebinder>();
        services.AddSingleton<IRestoreTargets, CoreRestoreTargets>();
        services.AddSingleton<ServerRestorer>();
        services.AddSingleton<BackupOperations>();

        services.AddHostedService<BackupScheduleStartup>();
        services.AddHangfireServer((provider, options) =>
        {
            options.ServerName = "runova-core";
            options.Queues = [Queue, "default"];
            options.WorkerCount = 2;
            options.ShutdownTimeout = TimeSpan.FromSeconds(5);
            options.StopTimeout = TimeSpan.FromSeconds(5);
        });
        return services;
    }
}
