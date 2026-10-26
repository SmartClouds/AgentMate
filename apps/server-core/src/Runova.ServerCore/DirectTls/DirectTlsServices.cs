using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Runova.ServerCore.DirectTls;

internal static class DirectTlsServices
{
    /// <summary>
    /// Registers the direct TLS listener. Nothing is bound until the mode is turned on: the endpoint
    /// only exists in configuration while it is.
    /// </summary>
    public static WebApplicationBuilder AddDirectTls(this WebApplicationBuilder builder)
    {
        ArgumentNullException.ThrowIfNull(builder);
        var endpoint = new DirectTlsEndpoint();
        ((IConfigurationBuilder)builder.Configuration).Add(endpoint);
        builder.Services.AddSingleton(endpoint);
        builder.Services.AddSingleton<DirectTlsDevices>();
        builder.Services.TryAddSingleton<IDirectTlsBinding, KestrelDirectTlsBinding>();
        builder.Services.AddSingleton<DirectTlsManager>();
        builder.Services.AddHostedService<DirectTlsStartup>();
        builder.WebHost.ConfigureKestrel(kestrel =>
            kestrel.ConfigurationLoader?.Endpoint(
                DirectTlsEndpoint.Name,
                configuration => endpoint.Configure(configuration, kestrel.ApplicationServices.GetRequiredService<DirectTlsDevices>())));
        return builder;
    }
}
