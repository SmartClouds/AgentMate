using Microsoft.Extensions.DependencyInjection.Extensions;
using Runova.ServerCore.Certificates;
using Runova.ServerCore.Certificates.Acme;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Hosting;
using Runova.ServerCore.Hubs;
using Runova.ServerCore.Jobs;
using Runova.ServerCore.Nginx;
using Runova.ServerCore.Updates;

namespace Runova.ServerCore.Web;

/// <summary>What the hub's website and certificate methods use, in one parameter.</summary>
internal sealed record WebServices(
    WebSites Sites,
    WebJobs Jobs,
    SiteLogs Logs,
    CertificateService Certificates,
    StreamLimits Streams);

/// <summary>Installing nginx is a job; it holds the nginx lock (and the packages lock while packages change).</summary>
internal sealed class WebJobs(JobEngine jobs, NginxSetup setup, NginxApplier applier, WebSites sites)
{
    public const string NginxLock = "nginx";

    public Task<JobInfo> InstallNginxAsync(Requester who, CancellationToken cancellationToken) =>
        jobs.StartAsync(
            new JobRequest(JobKind.NginxInstall, "Install and set up nginx", [NginxLock, SystemJobs.PackagesLock], "nginx", who.UserId, who.UserName),
            async (job, token) =>
            {
                using var lease = await applier.LockAsync(token);
                var (_, layout) = await sites.InspectAsync(token);
                await setup.InstallAsync(layout, job, token);
            },
            cancellationToken);
}

/// <summary>On start: an apply the previous core left halfway is finished or undone before anything else touches nginx.</summary>
internal sealed partial class WebStartup(WebSites sites, ILogger<WebStartup> logger) : IHostedService
{
    public async Task StartAsync(CancellationToken cancellationToken)
    {
        try
        {
            await sites.RecoverAsync(cancellationToken);
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            // The core still starts: the app shows nginx's state, and the next apply starts clean.
            LogRecoveryFailed(logger, error);
        }
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    [LoggerMessage(Level = LogLevel.Error, Message = "Recovering an interrupted nginx apply failed.")]
    private static partial void LogRecoveryFailed(ILogger logger, Exception error);
}

/// <summary>
/// Websites (nginx) and certificates (ACME). The machine underneath is the real server unless
/// the DevHost or a test registers another <see cref="INginxMachine"/> after this.
/// </summary>
internal static class WebOperations
{
    /// <summary>Call after <see cref="CoreOperations.AddCoreOperations"/>: it uses the jobs, alerts and process runner.</summary>
    public static IServiceCollection AddWebOperations(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);
        services.TryAddSingleton<INginxMachine>(provider => new LocalNginxMachine(
            provider.GetRequiredService<IProcessRunner>(),
            provider.GetRequiredService<SystemdRunner>()));
        services.AddSingleton(provider => new NginxControl(provider.GetRequiredService<INginxMachine>(), provider.GetRequiredService<TimeProvider>()));
        services.AddSingleton<NginxSeLinux>();
        services.TryAddSingleton<IUpstreamResolver, DnsUpstreamResolver>();
        services.AddSingleton(provider => UpstreamPolicy.For(CoreListenOptions.From(provider.GetRequiredService<IConfiguration>(), OperatingSystem.IsLinux())));
        services.AddSingleton<NginxApplier>();
        services.TryAddSingleton<INginxSigningKeySource, HttpNginxSigningKeySource>();
        services.AddSingleton<NginxSetup>();
        services.AddSingleton<CertificateKeys>();
        services.AddSingleton<WebSites>();
        services.AddSingleton<WebJobs>();
        services.AddSingleton(provider => new SiteLogs(provider.GetRequiredService<INginxMachine>(), provider.GetRequiredService<TimeProvider>()));

        services.TryAddSingleton<IAcmeHttp, AcmeHttp>();
        services.AddSingleton(provider => AcmeDirectoryChoice.From(provider.GetRequiredService<IConfiguration>()));
        services.TryAddSingleton<IAcmeAccountStore, EfAcmeAccountStore>();
        services.TryAddSingleton<IAcmeCertificateStore, EfAcmeCertificateStore>();
        services.TryAddSingleton<IHttp01ChallengePublisher>(provider => new WebrootChallengePublisher(
            provider.GetRequiredService<INginxMachine>(),
            NginxControl.LayoutFor(provider.GetRequiredService<OsInfo>().Family, NginxInspection.Missing(false, true))));
        services.TryAddSingleton<ICertificateAuthorities, AcmeIssuers>();
        services.AddSingleton<CertificateService>();
        services.TryAddSingleton(new CertificateRenewalOptions());
        services.AddSingleton<CertificateRenewals>();
        services.AddSingleton<WebServices>();

        services.AddHostedService<WebStartup>();
        services.AddHostedService(provider => provider.GetRequiredService<CertificateRenewals>());
        return services;
    }
}
