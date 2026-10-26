using System.Net;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.HostFiltering;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using Runova.ServerCore.Audit;
using Runova.ServerCore.Cloudflare;
using Runova.ServerCore.Data;
using Runova.ServerCore.DirectTls;
using Runova.ServerCore.Endpoints;
using Runova.ServerCore.ErrorReporting;
using Runova.ServerCore.Hosting;
using Runova.ServerCore.Hubs;
using Runova.ServerCore.Notifications;
using Runova.ServerCore.Security;
using Runova.ServerCore.Web;

namespace Runova.ServerCore;

/// <summary>
/// Builds the web host. Building has no side effects (tools and the test factory build it without
/// running it); anything that touches the machine happens when the server starts.
/// </summary>
internal static class CoreApplication
{
    /// <summary>Written by the installer; command-line arguments still override it.</summary>
    public static string ConfigFile => CoreLayout.Current.ConfigFile;

    /// <summary>
    /// The only Host headers the core answers to. The app sends "runova-core", or the old name
    /// until it knows the core is new enough (both are accepted for good); the loopback names
    /// cover development. Anything else is a rebinding attempt or a mistake.
    /// </summary>
    public static readonly string[] AllowedHosts = [.. CoreLayout.HostNames, "localhost", "127.0.0.1", "[::1]"];

    private const int MaxMessageBytes = 64 * 1024;

    /// <param name="configureServices">
    /// Runs after the core's own registrations. The DevHost puts its fake platform in here; the
    /// published core never passes one.
    /// </param>
    public static WebApplication Build(string[] args, Action<IServiceCollection>? configureServices = null)
    {
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { Args = args });
        builder.Configuration.AddJsonFile(ConfigFile, optional: true, reloadOnChange: false);
        builder.Configuration.AddCommandLine(args);
        // Every SQL statement at Information level would bury the journal; problems still show.
        builder.Logging.AddFilter("Microsoft.EntityFrameworkCore.Database.Command", LogLevel.Warning);
        // SignalR's debug log prints each invocation's arguments, and a deploy's carry registry
        // sign-ins (E08). Their ToString hides the secret too; this keeps the journal out of it.
        builder.Logging.AddFilter("Microsoft.AspNetCore.SignalR", LogLevel.Information);

        var listen = CoreListenOptions.From(builder.Configuration, OperatingSystem.IsLinux());
        builder.WebHost.ConfigureKestrel(kestrel => ConfigureKestrel(kestrel, listen));

        builder.Services.Configure<HostFilteringOptions>(options =>
        {
            options.AllowedHosts = AllowedHosts;
            options.AllowEmptyHosts = false;
            options.IncludeFailureMessage = false;
        });
        builder.Services.ConfigureHttpJsonOptions(options => CoreJson.Configure(options.SerializerOptions));
        builder.Services.AddSingleton(TimeProvider.System);
        builder.Services.AddSingleton<CoreStartup>();
        builder.Services.AddSingleton<CoreInstance>();

        // The database, Identity, encryption keys and audit trail live in the core's own state
        // folder (root only), resolved when first needed so tests and tools can point it elsewhere.
        builder.Services.AddCoreData(services =>
            CorePaths.DataDirectory(services.GetRequiredService<IConfiguration>(), OperatingSystem.IsLinux()));
        builder.Services.AddHostedService<DatabaseStartup>();
        builder.Services.AddHostedService<AuditRetention>();
        builder.Services.AddCoreOperations();
        builder.Services.AddWebOperations();
        builder.Services.AddCloudflare();
        // The opt-in HTTPS listener (E16): nothing is bound until the mode is turned on.
        builder.AddDirectTls();
        // Warnings and errors to a Sentry project as OpenTelemetry logs, once a person sets it up (E29).
        builder.AddErrorReporting();
        // Alerts to a Telegram chat through a bot, once a person sets it up (E30).
        builder.Services.AddTelegramNotifications();
        // Reports readiness to systemd (Type=notify), so `systemctl start` only returns once the
        // socket is listening and fails outright for a release that cannot start.
        builder.Services.AddSystemd();

        builder.Services.AddSingleton<AuthChallenges>();
        builder.Services.AddSingleton<AccessTokens>();
        builder.Services.AddSingleton<AuthThrottle>();
        builder.Services.AddScoped<DeviceSessions>();
        builder.Services.AddScoped<EnrollmentCodes>();
        builder.Services.AddSingleton<HubConnections>();
        builder.Services.AddScoped<IAuthorizationHandler, StepUpHandler>();
        builder.Services
            .AddAuthentication(CoreAuthentication.Scheme)
            .AddScheme<AuthenticationSchemeOptions, DeviceTokenHandler>(
                CoreAuthentication.Scheme,
                configureOptions: null);
        // A ceiling on the sign-in routes as a whole; each user name has its own, lower limit.
        builder.Services.AddRateLimiter(options =>
        {
            options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
            options.AddFixedWindowLimiter(AuthThrottle.Policy, limit =>
            {
                limit.PermitLimit = 60;
                limit.Window = TimeSpan.FromMinutes(1);
                limit.QueueLimit = 0;
            });
        });
        builder.Services.AddAuthorizationBuilder().AddCorePolicies();

        builder.Services
            .AddSignalR(options =>
            {
                options.EnableDetailedErrors = false;
                options.MaximumReceiveMessageSize = MaxMessageBytes;
                options.MaximumParallelInvocationsPerClient = 4;
                options.StreamBufferCapacity = 32;
            })
            .AddJsonProtocol(options => CoreJson.Configure(options.PayloadSerializerOptions));

        configureServices?.Invoke(builder.Services);
        var app = builder.Build();

        // Host filtering already ran (the host adds it first). Origin checks come next, then
        // authentication, so a browser request is refused without ever being authenticated.
        app.UseMiddleware<OriginRejectionMiddleware>();
        // Over direct TLS, every request names its device again from the client certificate.
        app.UseMiddleware<DirectTlsGuard>();
        app.UseRouting();
        app.UseRateLimiter();
        app.UseAuthentication();
        app.UseAuthorization();

        app.MapHealthEndpoints();
        app.MapAuthEndpoints();
        app.MapStackEndpoints();
        app.MapBackupEndpoints();
        app.MapFileEndpoints();
        app.MapCoreUpdateEndpoints();
        app.MapHub<CoreHub>(CoreHub.Path, options =>
            {
                options.Transports = HttpTransportType.WebSockets;
                options.CloseOnAuthenticationExpiration = true;
                options.ApplicationMaxBufferSize = MaxMessageBytes;
                options.TransportMaxBufferSize = MaxMessageBytes;
            })
            .RequireAuthorization(CorePolicies.SignedIn);

        app.Lifetime.ApplicationStarted.Register(() => RestrictSocketPermissions(app.Services));
        return app;
    }

    private static void ConfigureKestrel(KestrelServerOptions kestrel, CoreListenOptions listen)
    {
        kestrel.AddServerHeader = false;
        var limits = kestrel.Limits;
        limits.MaxRequestBodySize = 10 * 1024 * 1024;
        limits.MaxRequestHeadersTotalSize = 32 * 1024;
        limits.MaxRequestHeaderCount = 64;
        limits.MaxRequestLineSize = 8 * 1024;
        limits.RequestHeadersTimeout = TimeSpan.FromSeconds(15);
        limits.KeepAliveTimeout = TimeSpan.FromMinutes(2);
        limits.MaxConcurrentConnections = 64;
        limits.MaxConcurrentUpgradedConnections = 32;

        if (listen.TcpPort is int port)
        {
            kestrel.Listen(IPAddress.Loopback, port);
        }
        else if (listen.SocketPath is string path)
        {
            // Before the socket is bound: a second core on the same state stops here.
            kestrel.ApplicationServices.GetRequiredService<CoreInstance>().Hold();
            UnixSocketFile.PrepareForBind(path);
            kestrel.ListenUnixSocket(path);
        }
    }

    /// <summary>Only what Kestrel actually bound is touched, so the test server leaves files alone.</summary>
    private static void RestrictSocketPermissions(IServiceProvider services)
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        var addresses = services.GetRequiredService<IServer>()
            .Features.Get<IServerAddressesFeature>()?.Addresses ?? [];
        foreach (var address in addresses)
        {
            if (UnixSocketFile.PathFromServerAddress(address) is { } path)
            {
                UnixSocketFile.RestrictPermissions(path);
            }
        }
    }
}
