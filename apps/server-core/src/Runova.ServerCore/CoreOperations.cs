using Runova.ServerCore.Alerts;
using Runova.ServerCore.Assistant;
using Runova.ServerCore.Backups;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Docker;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Files;
using Runova.ServerCore.Firewall;
using Runova.ServerCore.Hardening;
using Runova.ServerCore.Hosting;
using Runova.ServerCore.Hubs;
using Runova.ServerCore.Jobs;
using Runova.ServerCore.Metrics;
using Runova.ServerCore.Platform;
using Runova.ServerCore.Registries;
using Runova.ServerCore.Stacks;
using Runova.ServerCore.Updates;

namespace Runova.ServerCore;

/// <summary>What the hub's server methods use, in one place so the hub takes one parameter for them.</summary>
internal sealed record ServerServices(
    SystemJobs SystemJobs,
    JobEngine Jobs,
    AlertCenter Alerts,
    MetricsSampler Metrics,
    UpdatesCache Updates,
    ISystemInfoSource Info,
    IServiceManager Services,
    StreamLimits Streams,
    CoreUpdater CoreUpdater,
    LayoutMigrator LayoutMigrator);

/// <summary>
/// Running the server: programs and transient units, the platform layer (Linux here; the DevHost
/// and the tests put fakes in its place), jobs, metrics, updates and alerts.
/// </summary>
internal static class CoreOperations
{
    /// <summary>Call after the database's startup service: hosted services start in order, and these need it.</summary>
    public static IServiceCollection AddCoreOperations(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);

        services.AddSingleton<IProcessRunner, ProcessRunner>();
        services.AddSingleton<SystemdRunner>();
        services.AddSingleton<ISystemFiles>(_ => new SystemFiles());
        services.AddSingleton<IFileSystemStats, DriveStats>();
        services.AddSingleton(provider =>
        {
            var files = provider.GetRequiredService<ISystemFiles>();
            var text = files.ReadText(OsRelease.Path) ?? files.ReadText(OsRelease.FallbackPath) ?? string.Empty;
            return OsRelease.Describe(OsRelease.Parse(text));
        });
        services.AddSingleton<IPackageManager>(provider =>
            provider.GetRequiredService<OsInfo>().Family switch
            {
                OsFamily.Debian => new AptPackageManager(
                    provider.GetRequiredService<IProcessRunner>(),
                    provider.GetRequiredService<SystemdRunner>(),
                    provider.GetRequiredService<ISystemFiles>()),
                OsFamily.Rhel => new DnfPackageManager(
                    provider.GetRequiredService<IProcessRunner>(),
                    provider.GetRequiredService<SystemdRunner>(),
                    provider.GetRequiredService<ISystemFiles>()),
                _ => new UnsupportedPackageManager(),
            });
        services.AddSingleton<IServiceManager>(provider => new SystemdServices(
            provider.GetRequiredService<IProcessRunner>(),
            provider.GetRequiredService<ISystemFiles>(),
            provider.GetRequiredService<OsInfo>()));
        services.AddSingleton<ISystemProbe>(provider => new LinuxSystemProbe(
            provider.GetRequiredService<ISystemFiles>(),
            provider.GetRequiredService<IFileSystemStats>()));
        services.AddSingleton<ISystemInfoSource>(provider => new LinuxSystemInfo(
            provider.GetRequiredService<ISystemFiles>(),
            provider.GetRequiredService<ISystemProbe>(),
            provider.GetRequiredService<IPackageManager>(),
            provider.GetRequiredService<IProcessRunner>(),
            provider.GetRequiredService<OsInfo>(),
            provider.GetRequiredService<TimeProvider>(),
            LinuxSystemInfo.ReadNetworkInterfaces));
        services.AddSingleton<IPowerControl, SystemdPower>();

        services.AddSingleton(provider => new CoreDirectories(
            CorePaths.DataDirectory(provider.GetRequiredService<IConfiguration>(), OperatingSystem.IsLinux())));
        services.AddSingleton<AlertCenter>();
        services.AddSingleton<JobEngine>();
        services.AddSingleton<MetricsStore>();
        services.AddSingleton<MetricsSampler>();
        services.AddSingleton<UpdatesCache>();
        services.AddSingleton<SystemJobs>();

        // The core updating itself (no SSH): GitHub's release links redirect to its file host.
        services.AddSingleton(CoreLayout.Current);
        services.AddSingleton<ICoreInstallation, SystemdCoreInstallation>();
        services.AddSingleton<CoreUpdater>();
        // Moving a server off the layout from before the rename, which the app asks for after an update.
        services.AddSingleton(provider => new LayoutMigrationJournalFile(
            provider.GetRequiredService<IConfiguration>()["Core:MigrationJournal"] is { Length: > 0 } journal ? journal : LayoutMigrationPlan.JournalPath));
        services.AddSingleton<LayoutMigrator>();
        services.AddHttpClient(CoreUpdater.HttpClientName, client =>
        {
            client.Timeout = Timeout.InfiniteTimeSpan;
            client.DefaultRequestHeaders.UserAgent.ParseAdd($"Runova-Core/{CoreVersion.Current}");
        });
        services.AddSingleton<StreamLimits>();
        services.AddSingleton<ServerServices>();
        services.AddCoreDocker();

        // Files in containers and volumes (E27), through the engine.
        services.AddCoreFiles();

        // Recovery of jobs a previous core left running comes first, then the samplers and checks.
        services.AddHostedService(provider => provider.GetRequiredService<JobEngine>());
        services.AddHostedService(provider => provider.GetRequiredService<MetricsSampler>());
        services.AddHostedService(provider => provider.GetRequiredService<UpdatesCache>());
        services.AddHostedService<AlertMonitor>();
        // Containers that keep crashing (E30), from Docker's events.
        services.AddSingleton(ContainerWatchOptions.Default);
        services.AddHostedService<ContainerWatcher>();
        services.AddHostedService<CoreMaintenance>();

        // The host firewall (E13): its change sets settle themselves once the database is up.
        services.AddCoreFirewall();

        // Private registries (E08): stored credentials and the per-job DOCKER_CONFIG folders.
        services.AddCoreRegistries();

        // The Security center (E15): sshd changes that undo themselves unless kept, like the firewall's.
        services.AddCoreSecurityCenter();

        // Compose stacks (E07): after the job engine, so its recovery runs after the jobs' own.
        services.AddCoreStacks();

        // Server backups (E28): plans on Hangfire's schedule, then its server.
        services.AddCoreBackups();

        // The Deploy AI's exec stream and the logs center's journal (E09).
        services.AddCoreAssistant();
        return services;
    }
}
