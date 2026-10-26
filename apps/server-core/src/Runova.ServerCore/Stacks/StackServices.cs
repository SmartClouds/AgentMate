using Runova.ServerCore.Execution;

namespace Runova.ServerCore.Stacks;

/// <summary>
/// Compose stacks in the core (E07): docker compose through the process runner, and the
/// operations the hub and the upload routes call. The DevHost and the tests put a simulated
/// compose in place of the real one.
/// </summary>
internal static class StackServices
{
    public static IServiceCollection AddCoreStacks(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);
        services.AddSingleton<IComposeRunner>(provider => new DockerComposeRunner(
            provider.GetRequiredService<IProcessRunner>(),
            provider.GetRequiredService<SystemdRunner>()));
        services.AddSingleton<StackOperations>();
        services.AddHostedService<StackRecovery>();
        return services;
    }
}

/// <summary>At start-up, after the jobs' own recovery: deploys nobody saw finish are marked failed.</summary>
internal sealed class StackRecovery(StackOperations stacks) : IHostedService
{
    public Task StartAsync(CancellationToken cancellationToken) => stacks.RecoverAsync(cancellationToken);

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
