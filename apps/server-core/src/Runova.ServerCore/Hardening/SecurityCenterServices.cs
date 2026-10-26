using Runova.ServerCore.Backups;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Hosting;

namespace Runova.ServerCore.Hardening;

/// <summary>What the hub's Security center methods use, in one place so the hub takes one parameter for them.</summary>
internal sealed record SecurityCenterServices(SshHardeningManager Ssh, BackupService Backups);

internal static class SecurityCenterRegistration
{
    /// <summary>
    /// sshd on Linux (its settings, its sign-in log and the rollback timer in systemd). The DevHost
    /// and the tests register fakes after this, which take its place.
    /// </summary>
    public static IServiceCollection AddCoreSecurityCenter(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);
        services.AddSingleton(new SshHardeningOptions());
        services.AddSingleton<ISshMachine>(provider => new LinuxSshMachine(
            provider.GetRequiredService<IProcessRunner>(),
            provider.GetRequiredService<OsInfo>().Family));
        services.AddSingleton<ISshLoginLog>(provider => new JournalSshLoginLog(provider.GetRequiredService<IProcessRunner>()));
        services.AddSingleton<ISshHardeningTimer>(provider => new SystemdSshHardeningTimer(
            provider.GetRequiredService<SystemdRunner>(),
            provider.GetRequiredService<SshHardeningOptions>(),
            provider.GetRequiredService<CoreDirectories>()));
        services.AddSingleton<SshHardeningManager>();
        services.AddSingleton<BackupService>();
        services.AddSingleton<SecurityCenterServices>();
        services.AddHostedService(provider => provider.GetRequiredService<SshHardeningManager>());
        return services;
    }
}
