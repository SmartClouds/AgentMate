using Microsoft.Extensions.DependencyInjection.Extensions;

namespace AgentMate.ServerCore.Files;

/// <summary>The file manager for containers and volumes (E27): one service, which also sweeps its helpers.</summary>
internal static class FileServices
{
    public static IServiceCollection AddCoreFiles(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);
        services.TryAddSingleton(FileServiceOptions.Default);
        services.AddSingleton<ContainerFilesService>();
        services.AddHostedService(provider => provider.GetRequiredService<ContainerFilesService>());
        return services;
    }
}
