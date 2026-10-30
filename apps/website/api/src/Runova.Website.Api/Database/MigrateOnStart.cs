using Microsoft.EntityFrameworkCore;
using Runova.Website.Data;

namespace Runova.Website.Api.Database;

/// <summary>
/// Applies the migrations before the server starts listening, when
/// <c>Database__MigrateOnStart=true</c> (compose sets it). Otherwise <c>admin migrate</c> does.
/// </summary>
internal sealed class MigrateOnStart(IServiceProvider services, IConfiguration configuration) : IHostedLifecycleService
{
    public async Task StartingAsync(CancellationToken cancellationToken)
    {
        if (!configuration.GetValue<bool>("Database:MigrateOnStart"))
        {
            return;
        }

        using var scope = services.CreateScope();
        await scope.ServiceProvider.GetRequiredService<AppDbContext>().Database.MigrateAsync(cancellationToken);
    }

    public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public Task StartedAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public Task StoppingAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public Task StoppedAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
