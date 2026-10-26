using Runova.ServerCore.Hosting;
namespace Runova.ServerCore.Registries;

/// <summary>
/// Private registries (E08): stored credentials and the per-job DOCKER_CONFIG folders under the
/// runtime directory (systemd's RuntimeDirectory, a tmpfs). `Core:RuntimeDirectory` moves it, and
/// `Core:RegistryAuthOnDisk=allow` lets the DevHost and the tests use a plain folder; a real server
/// never sets it.
/// </summary>
internal static class RegistryServices
{
    public static string LinuxRuntimeDirectory => CoreLayout.Current.RuntimeDirectory;

    public const string FolderName = "registry-auth";

    public static IServiceCollection AddCoreRegistries(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);
        services.AddSingleton<RegistryCredentials>();
        services.AddSingleton(provider =>
        {
            var configuration = provider.GetRequiredService<IConfiguration>();
            var runtime = configuration["Core:RuntimeDirectory"] is { Length: > 0 } configured
                ? configured
                : OperatingSystem.IsLinux()
                    ? LinuxRuntimeDirectory
                    : Path.Combine(Path.GetTempPath(), "runova-core-runtime");
            var allowDisk = string.Equals(configuration["Core:RegistryAuthOnDisk"], "allow", StringComparison.Ordinal);
            return new RegistryAuthFolders(
                Path.Combine(runtime, FolderName),
                requireMemoryFilesystem: OperatingSystem.IsLinux() && !allowDisk,
                ReadMountTable,
                provider.GetRequiredService<ILogger<RegistryAuthFolders>>());
        });
        services.AddHostedService<RegistryAuthSweep>();
        return services;
    }

    private static string? ReadMountTable()
    {
        try
        {
            return File.Exists(MountTable.Path) ? File.ReadAllText(MountTable.Path) : null;
        }
        catch (IOException)
        {
            return null;
        }
    }
}

/// <summary>At start-up no job runs, so any DOCKER_CONFIG folder there is left from a core that stopped mid-job.</summary>
internal sealed partial class RegistryAuthSweep(RegistryAuthFolders folders, ILogger<RegistryAuthSweep> logger) : IHostedService
{
    public Task StartAsync(CancellationToken cancellationToken)
    {
        var swept = folders.Sweep();
        if (swept > 0)
        {
            LogSwept(logger, swept);
        }

        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    [LoggerMessage(Level = LogLevel.Warning, Message = "Wiped {Count} registry sign-in folders a previous core left behind.")]
    private static partial void LogSwept(ILogger logger, int count);
}
