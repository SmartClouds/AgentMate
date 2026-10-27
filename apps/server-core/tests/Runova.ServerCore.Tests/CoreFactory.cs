using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Runova.ServerCore.Alerts;
using Runova.ServerCore.Assistant;
using Runova.ServerCore.Backups;
using Runova.ServerCore.Cloudflare;
using Runova.ServerCore.DevHost.Fakes;
using Runova.ServerCore.DirectTls;
using Runova.ServerCore.Docker;
using Runova.ServerCore.ErrorReporting;
using Runova.ServerCore.Firewall;
using Runova.ServerCore.Hardening;
using Runova.ServerCore.Nginx;
using Runova.ServerCore.Notifications;
using Runova.ServerCore.Platform;
using Runova.ServerCore.Stacks;
using Runova.ServerCore.Tests.Cloudflare;
using Runova.ServerCore.Tests.Docker;
using Runova.ServerCore.Tests.ErrorReporting;
using Runova.ServerCore.Tests.Notifications;
using Runova.ServerCore.Updates;

namespace Runova.ServerCore.Tests;

/// <summary>
/// Boots the real web host through its entry point, with an in-memory server in place of Kestrel,
/// so every test exercises the same pipeline production runs. The machine underneath is fake: no
/// test reads the real /proc or starts apt, and every call that would change the server is logged
/// (<see cref="MutationLog"/>).
/// </summary>
public sealed class CoreFactory : WebApplicationFactory<Program>
{
    /// <summary>Each factory gets its own data folder, so no test touches /var/lib or a real key ring.</summary>
    private readonly string _dataDirectory = Path.Combine(Path.GetTempPath(), $"core-tests-{Guid.NewGuid():N}");

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        builder.UseEnvironment("Testing");
        builder.UseSetting("Core:DataDirectory", _dataDirectory);
        // Registry sign-ins (E08) go to a plain folder here: test machines have no tmpfs to spare.
        builder.UseSetting("Core:RuntimeDirectory", Path.Combine(_dataDirectory, "run"));
        builder.UseSetting("Core:RegistryAuthOnDisk", "allow");
        builder.UseSetting("Core:DirectTls:LoopbackOnly", "true");
        builder.ConfigureServices(services =>
        {
            services.AddSingleton<MutationLog>();
            services.AddSingleton<FakeSystemProbe>();
            services.AddSingleton<ISystemProbe>(provider => provider.GetRequiredService<FakeSystemProbe>());
            services.AddSingleton<FakePackageManager>();
            services.AddSingleton<IPackageManager>(provider => provider.GetRequiredService<FakePackageManager>());
            services.AddSingleton<FakeServiceManager>();
            services.AddSingleton<IServiceManager>(provider => provider.GetRequiredService<FakeServiceManager>());
            services.AddSingleton<IPowerControl, FakePowerControl>();
            services.AddSingleton<ISystemInfoSource, FakeSystemInfoSource>();
            services.AddSingleton<FakeFirewallBackend>();
            services.AddSingleton<IFirewallBackendSource>(provider => provider.GetRequiredService<FakeFirewallBackend>());
            services.AddSingleton<IFirewallTimer, FakeFirewallTimer>();
            services.AddSingleton<ISshdSettings, FakeSshd>();
            services.AddSingleton<FakeCallerConnections>();
            services.AddSingleton<ICallerConnections>(provider => provider.GetRequiredService<FakeCallerConnections>());
            services.AddSingleton<IExposureSource, FakeExposure>();

            // sshd for the Security center: passwords on, connections signed in with a key unless a test says otherwise.
            services.AddSingleton<FakeSshMachine>();
            services.AddSingleton<ISshMachine>(provider => provider.GetRequiredService<FakeSshMachine>());
            services.AddSingleton<FakeSshLoginLog>();
            services.AddSingleton<ISshLoginLog>(provider => provider.GetRequiredService<FakeSshLoginLog>());
            services.AddSingleton<FakeSshHardeningTimer>();
            services.AddSingleton<ISshHardeningTimer>(provider => provider.GetRequiredService<FakeSshHardeningTimer>());
            // Direct TLS: the in-memory server binds no ports, so the listener counts as open
            // whenever the mode asks for it.
            services.AddSingleton<IDirectTlsBinding, FakeDirectTlsBinding>();

            // Docker: the pretend engine (shared with the DevHost) and an installer that only records.
            services.AddSingleton(provider => new InMemoryDockerEngine(provider.GetRequiredService<TimeProvider>()) { Tick = TimeSpan.FromMilliseconds(50) });
            services.AddSingleton<IDockerEngine>(provider => provider.GetRequiredService<InMemoryDockerEngine>());
            services.AddSingleton<FakeDockerSetup>();
            services.AddSingleton<IDockerSetup>(provider => provider.GetRequiredService<FakeDockerSetup>());

            // docker compose, simulated on the pretend engine without delays.
            services.AddSingleton(provider => new SimulatedCompose(
                provider.GetRequiredService<InMemoryDockerEngine>(),
                provider.GetRequiredService<TimeProvider>())
            { LineDelay = TimeSpan.Zero });
            services.AddSingleton<IComposeRunner>(provider => provider.GetRequiredService<SimulatedCompose>());

            // nginx on a simulated server, installed and running but not set up for Runova.
            services.AddSingleton(_ => new SimulatedNginxMachine(installed: true));
            services.AddSingleton<INginxMachine>(provider => provider.GetRequiredService<SimulatedNginxMachine>());

            // Cloudflare (E14): never the real API, and no refresh unless a test asks for one.
            services.AddSingleton<FakeCloudflareApi>();
            services.AddSingleton<ICloudflareRangeSource>(provider => provider.GetRequiredService<FakeCloudflareApi>());
            services.AddSingleton<ICloudflareDnsApi>(provider => provider.GetRequiredService<FakeCloudflareApi>());
            services.AddSingleton(OriginLockOptions.Default with { RunInBackground = false });
            services.AddSingleton(new CloudflareDns01Options(TimeSpan.Zero));
            // StreamExec and the journal (E09): recorded and answered, nothing runs.
            services.AddSingleton(provider => new FakeExecRunner(
                provider.GetRequiredService<InMemoryDockerEngine>(),
                provider.GetRequiredService<TimeProvider>())
            { LineDelay = TimeSpan.Zero });
            services.AddSingleton<IExecRunner>(provider => provider.GetRequiredService<FakeExecRunner>());
            services.AddSingleton<IJournalSource, FakeJournal>();

            // Error reporting (E29): a fake Sentry, so nothing a test logs ever leaves the machine.
            services.AddSingleton<FakeIngest>();
            services.AddSingleton<IErrorReportingTransport>(provider => new FakeIngestTransport(provider.GetRequiredService<FakeIngest>()));

            // Crash loops (E30): tests stop and kill containers all the time, so nothing watches for them.
            services.AddSingleton(new ContainerWatchOptions(RunInBackground: false));

            // The move to the Runova names: it would look at this machine's sshd drop-in.
            services.AddSingleton(new LegacyNamesMoveOptions(RunInBackground: false));

            // Hangfire's workers (E28): only the tests that run a backup start them (HubServerBackupTests).
            services.AddSingleton(new BackupJobServerOptions(RunInBackground: false));

            // Telegram notifications (E30): a fake Bot API, so no alert a test raises reaches a chat.
            services.AddSingleton<FakeTelegramApi>();
            services.AddSingleton<ITelegramTransport>(provider => new FakeTelegramTransport(provider.GetRequiredService<FakeTelegramApi>().Handler));
        });
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (disposing)
        {
            TestFolders.Delete(_dataDirectory);
        }
    }
}
