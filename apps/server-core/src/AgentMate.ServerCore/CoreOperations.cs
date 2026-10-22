using AgentMate.ServerCore.Alerts;
using AgentMate.ServerCore.Assistant;
using AgentMate.ServerCore.Backups;
using AgentMate.ServerCore.Contracts;
using AgentMate.ServerCore.Docker;
using AgentMate.ServerCore.Execution;
using AgentMate.ServerCore.Files;
using AgentMate.ServerCore.Firewall;
using AgentMate.ServerCore.Hardening;
using AgentMate.ServerCore.Hosting;
using AgentMate.ServerCore.Hubs;
using AgentMate.ServerCore.Jobs;
using AgentMate.ServerCore.Metrics;
using AgentMate.ServerCore.Platform;
using AgentMate.ServerCore.Registries;
using AgentMate.ServerCore.Stacks;
using AgentMate.ServerCore.Updates;

namespace AgentMate.ServerCore;

/// <summary>What the hub's server methods use, in one place so the hub takes one parameter for them.</summary>
internal sealed record ServerServices(
    SystemJobs SystemJobs,
    JobEngine Jobs,
    AlertCenter Alerts,
    MetricsSampler Metrics,
    UpdatesCache Updates,
    ISystemInfoSource Info,
    IServiceManager Services,
    StreamLimits Streams);

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
