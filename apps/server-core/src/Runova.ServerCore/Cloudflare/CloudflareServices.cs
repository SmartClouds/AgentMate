using Runova.ServerCore.Certificates.Acme;

namespace Runova.ServerCore.Cloudflare;

/// <summary>What the hub's Cloudflare methods use, in one place so the hub takes one parameter for them.</summary>
internal sealed record CloudflareServices(OriginLockService OriginLock, OriginCertificates OriginCertificates, DnsCredentials DnsCredentials);

internal static class CloudflareServiceCollection
{
    /// <summary>
    /// Cloudflare on the server (E14): its API over HTTPS, the origin lock with its daily refresh,
    /// Origin CA certificates and DNS-01. Call after the web operations, whose sites and
    /// certificates it builds on. The DevHost and the tests register fakes for the API after this.
    /// </summary>
    public static IServiceCollection AddCloudflare(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);
        services.AddSingleton<ICloudflareHttp, CloudflareHttp>();
        services.AddSingleton<CloudflareApi>();
        services.AddSingleton<ICloudflareRangeSource>(provider => provider.GetRequiredService<CloudflareApi>());
        services.AddSingleton<ICloudflareDnsApi>(provider => provider.GetRequiredService<CloudflareApi>());
        services.AddSingleton(OriginLockOptions.Default);
        services.AddSingleton(CloudflareDns01Options.Default);
        services.AddSingleton<DnsCredentials>();
        services.AddSingleton<CloudflareDns01Hook>();
        services.AddSingleton<IDns01ChallengeHook>(provider => provider.GetRequiredService<CloudflareDns01Hook>());
        services.AddSingleton<OriginCertificates>();
        services.AddSingleton<OriginLockService>();
        services.AddSingleton<CloudflareServices>();
        services.AddHostedService(provider => provider.GetRequiredService<OriginLockService>());
        return services;
    }
}
