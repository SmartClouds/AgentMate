using Microsoft.AspNetCore.Identity;
using Runova.ServerCore.Data;
using Runova.ServerCore.Hosting;

namespace Runova.ServerCore.Data;

/// <summary>
/// Migrates the database and creates the roles before the socket opens. Hosted services start
/// before the server listens, so systemd only hears "ready" once the database is usable.
/// </summary>
internal sealed class DatabaseStartup(IServiceProvider services, IConfiguration configuration) : IHostedService
{
    public async Task StartAsync(CancellationToken cancellationToken)
    {
        var path = CoreDatabase.PathIn(CorePaths.DataDirectory(configuration, OperatingSystem.IsLinux()));
        await CoreDatabase.PrepareAsync(path, cancellationToken);
        await using var scope = services.CreateAsyncScope();
        await CoreServices.EnsureRolesAsync(scope.ServiceProvider.GetRequiredService<RoleManager<CoreRole>>());
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
