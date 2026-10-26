using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Runova.ServerCore.Backups;
using Runova.ServerCore.Nginx;

namespace Runova.ServerCore.Tests.Backups;

/// <summary>
/// What a restore brings up through the core itself (E28). A server that had no websites comes up
/// without nginx; one that had them says nginx is missing.
/// </summary>
public sealed class CoreRestoreTargetsTests
{
    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    [Fact]
    public async Task A_server_with_no_websites_comes_up_without_nginx()
    {
        await using var factory = new CoreFactory().WithWebHostBuilder(builder =>
            builder.ConfigureTestServices(services => services.AddSingleton(_ => new SimulatedNginxMachine(installed: false))));
        var targets = factory.Services.GetRequiredService<IRestoreTargets>();

        Assert.Null(await targets.ApplyWebsitesAsync(Cancel));
    }
}
