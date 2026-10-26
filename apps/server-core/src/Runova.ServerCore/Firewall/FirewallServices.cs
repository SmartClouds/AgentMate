using Runova.ServerCore.Contracts;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Hosting;
using Runova.ServerCore.Platform;

namespace Runova.ServerCore.Firewall;

/// <summary>What the hub's firewall methods use, in one place so the hub takes one parameter for them.</summary>
internal sealed record FirewallHubServices(FirewallManager Manager, ICallerConnections Connections, ISshdSettings Sshd, IExposureSource Exposure);

internal static class FirewallServices
{
    /// <summary>
    /// The firewall on Linux: ufw or firewalld, sshd's settings, the rollback timer in systemd, the
    /// peer of the core's socket, and the exposure inventory. The DevHost and the tests register
    /// fakes after this, which take its place.
    /// </summary>
    public static IServiceCollection AddCoreFirewall(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);
        services.AddSingleton(new FirewallOptions());
        services.AddSingleton<IFirewallCommands>(provider => new TransientUnitCommands(provider.GetRequiredService<SystemdRunner>()));
        services.AddSingleton<IFirewallBackendSource>(provider => new InstalledFirewall(
            provider.GetRequiredService<OsInfo>(),
            provider.GetRequiredService<IProcessRunner>(),
            provider.GetRequiredService<IFirewallCommands>(),
            provider.GetRequiredService<ISystemFiles>()));
        services.AddSingleton<ISshdSettings>(provider => new SshdSettings(provider.GetRequiredService<IProcessRunner>()));
        services.AddSingleton<IFirewallTimer>(provider => new SystemdFirewallTimer(
            provider.GetRequiredService<SystemdRunner>(),
            provider.GetRequiredService<FirewallOptions>(),
            provider.GetRequiredService<CoreDirectories>()));
        services.AddSingleton<IProcessTable, LinuxProcessTable>();
        services.AddSingleton<ICallerConnections>(provider => new LinuxCallerConnections(provider.GetRequiredService<IProcessTable>()));
        services.AddSingleton<IExposureSource>(provider => new ExposureInventorySource(
            provider.GetRequiredService<IProcessRunner>(),
            provider.GetRequiredService<IFirewallBackendSource>(),
            provider.GetRequiredService<TimeProvider>()));
        services.AddSingleton<FirewallManager>();
        services.AddSingleton<FirewallHubServices>();
        services.AddHostedService(provider => provider.GetRequiredService<FirewallManager>());
        return services;
    }
}
