using System.Net;
using Runova.ServerCore.Assistant;
using Runova.ServerCore.Certificates;
using Runova.ServerCore.Cloudflare;
using Runova.ServerCore.Docker;
using Runova.ServerCore.Firewall;
using Runova.ServerCore.Hardening;
using Runova.ServerCore.Nginx;
using Runova.ServerCore.Platform;
using Runova.ServerCore.Stacks;
using Runova.ServerCore.Updates;

namespace Runova.ServerCore.DevHost.Fakes;

/// <summary>
/// Puts the pretend machine in place of the Linux platform layer. Only the DevHost calls this,
/// and the DevHost is never published, so none of it can reach a real server.
/// </summary>
internal static class FakePlatform
{
    public static void Add(IServiceCollection services)
    {
        services.AddSingleton<FakeServer>();
        services.AddSingleton<FakeProbe>();
        services.AddSingleton<ISystemProbe>(provider => provider.GetRequiredService<FakeProbe>());
        services.AddSingleton<IPackageManager, FakePackages>();
        services.AddSingleton<IServiceManager, FakeServices>();
        services.AddSingleton<ISystemInfoSource, FakeSystemInfo>();
        services.AddSingleton<IPowerControl, FakePower>();
        services.AddSingleton<IStartupFilter, RebootingFilter>();

        services.AddSingleton<FakeFirewall>();
        services.AddSingleton<IFirewallBackendSource>(provider => provider.GetRequiredService<FakeFirewall>());
        services.AddSingleton<IFirewallTimer, FakeFirewallTimer>();
        services.AddSingleton<ISshdSettings, FakeSshd>();
        services.AddSingleton<ICallerConnections, FakeCallerConnections>();
        services.AddSingleton<IExposureSource, FakeExposure>();

        // sshd for the Security center (E15): passwords on, every connection a key login.
        services.AddSingleton<FakeSshMachine>();
        services.AddSingleton<ISshMachine>(provider => provider.GetRequiredService<FakeSshMachine>());
        services.AddSingleton<FakeSshLoginLog>();
        services.AddSingleton<ISshLoginLog>(provider => provider.GetRequiredService<FakeSshLoginLog>());
        services.AddSingleton<ISshHardeningTimer, FakeSshHardeningTimer>();

        // Docker: two compose projects with moving stats, growing logs and consoles (E06).
        services.AddSingleton(provider =>
        {
            var engine = new InMemoryDockerEngine(provider.GetRequiredService<TimeProvider>());
            // A private registry (E08) whose images only pull with this sign-in.
            engine.PrivateRegistries[DevHost.DevRegistry] = (DevHost.DevRegistryUser, DevHost.DevRegistryToken);
            // E09 adds a crash-looping "newsletter" sender for the problems feed and the Deploy AI.
            return engine.WithCrashLoop();
        });
        services.AddSingleton<IDockerEngine>(provider => provider.GetRequiredService<InMemoryDockerEngine>());
        services.AddSingleton<IDockerSetup, FakeDockerSetup>();

        // Server backups (E28): Docker as the pretend engine shows it, destinations in memory.
        FakeBackups.Add(services);

        // Compose stacks (E07): docker compose on the pretend engine, a few lines a second.
        services.AddSingleton(provider => new SimulatedCompose(
            provider.GetRequiredService<InMemoryDockerEngine>(),
            provider.GetRequiredService<TimeProvider>()));
        services.AddSingleton<IComposeRunner>(provider => provider.GetRequiredService<SimulatedCompose>());

        // Websites and certificates: nginx.org's nginx installed and running but not set up yet,
        // a pretend CA, and upstream names that all resolve to a documentation address.
        services.AddSingleton(_ => new SimulatedNginxMachine(installed: true));
        services.AddSingleton<INginxMachine>(provider => provider.GetRequiredService<SimulatedNginxMachine>());
        // Nothing here was set up before the rename, and the move would look at this machine's sshd drop-in.
        services.AddSingleton(new LegacyNamesMoveOptions(RunInBackground: false));
        services.AddSingleton<ICertificateAuthorities, FakeCertificateAuthorities>();
        services.AddSingleton<IUpstreamResolver, FakeResolver>();

        // Cloudflare (E14): its ranges and a DNS API in memory, and DNS-01 records without the wait.
        services.AddSingleton<FakeCloudflare>();
        services.AddSingleton<ICloudflareRangeSource>(provider => provider.GetRequiredService<FakeCloudflare>());
        services.AddSingleton<ICloudflareDnsApi>(provider => provider.GetRequiredService<FakeCloudflare>());
        services.AddSingleton(new CloudflareDns01Options(TimeSpan.Zero));
        // The Deploy AI's exec stream and the journal (E09): recorded and answered, never run.
        services.AddSingleton<FakeExecRunner>();
        services.AddSingleton<IExecRunner>(provider => provider.GetRequiredService<FakeExecRunner>());
        services.AddSingleton<IJournalSource, FakeJournal>();
    }

    private sealed class FakeResolver : IUpstreamResolver
    {
        public Task<IPAddress[]> ResolveAsync(string host, CancellationToken cancellationToken) =>
            Task.FromResult(new[] { IPAddress.Parse("192.0.2.10") });
    }

    /// <summary>While the pretend server reboots, nothing answers but 503, as nothing would answer at all.</summary>
    private sealed class RebootingFilter(FakeServer server) : IStartupFilter
    {
        public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
        {
            app.Use(async (context, following) =>
            {
                if (server.Rebooting)
                {
                    context.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
                    return;
                }

                await following(context);
            });
            next(app);
        };
    }
}
