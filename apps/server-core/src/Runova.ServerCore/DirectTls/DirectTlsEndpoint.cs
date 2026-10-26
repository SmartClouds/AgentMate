using System.Globalization;
using System.Net;
using System.Security.Authentication;
using System.Security.Cryptography.X509Certificates;
using Microsoft.AspNetCore.Server.Kestrel;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using Microsoft.AspNetCore.Server.Kestrel.Https;

namespace Runova.ServerCore.DirectTls;

/// <summary>
/// The direct TLS listener as Kestrel sees it: one configuration endpoint that exists only while
/// the mode is on. Kestrel watches its configuration and binds or closes the port when this
/// provider reloads, so turning the mode on or off needs no restart and leaves the Unix socket
/// alone. Everything about the endpoint that matters is set in code (<see cref="Configure"/>), not
/// read from configuration: TLS 1.3 only, HTTP/1.1, a client certificate required and checked
/// against the enrolled device keys, and a source check before the handshake starts.
/// </summary>
internal sealed class DirectTlsEndpoint : ConfigurationProvider, IConfigurationSource
{
    public const string Name = "RunovaDirectTls";

    private const string Prefix = $"Kestrel:Endpoints:{Name}";

    private readonly Lock _gate = new();

    private X509Certificate2? _certificate;

    private volatile IPNetwork[] _sources = [];

    public IConfigurationProvider Build(IConfigurationBuilder builder) => this;

    /// <summary>Binds the port (or moves it), or updates the sources on the port already bound.</summary>
    public void Open(int port, IPNetwork[] sources, X509Certificate2 certificate, bool loopbackOnly)
    {
        ArgumentNullException.ThrowIfNull(sources);
        ArgumentNullException.ThrowIfNull(certificate);
        lock (_gate)
        {
            _certificate = certificate;
            _sources = sources;
            var host = loopbackOnly ? "127.0.0.1" : "*";
            var url = string.Create(CultureInfo.InvariantCulture, $"https://{host}:{port}");
            if (Data.TryGetValue($"{Prefix}:Url", out var current) && current == url)
            {
                return;
            }

            // A new dictionary rather than edits, so Kestrel never reads one half changed.
            Data = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase)
            {
                [$"{Prefix}:Url"] = url,
                [$"{Prefix}:Protocols"] = nameof(HttpProtocols.Http1),
            };
        }

        OnReload();
    }

    public void Close()
    {
        lock (_gate)
        {
            if (Data.Count == 0)
            {
                return;
            }

            Data = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
            _sources = [];
        }

        OnReload();
    }

    /// <summary>Called by Kestrel each time it binds the endpoint.</summary>
    public void Configure(EndpointConfiguration endpoint, DirectTlsDevices devices)
    {
        ArgumentNullException.ThrowIfNull(endpoint);
        ArgumentNullException.ThrowIfNull(devices);
        var certificate = _certificate
            ?? throw new InvalidOperationException("The direct TLS certificate is not loaded.");

        // Before TLS: an address outside the allowed networks never gets a handshake.
        endpoint.ListenOptions.Use(next => async connection =>
        {
            var remote = (connection.RemoteEndPoint as IPEndPoint)?.Address;
            if (!DirectTlsSettings.Allows(_sources, remote))
            {
                connection.Abort();
                return;
            }

            await next(connection);
        });

        var https = endpoint.HttpsOptions;
        https.ServerCertificate = certificate;
        https.SslProtocols = SslProtocols.Tls13;
        https.ClientCertificateMode = ClientCertificateMode.RequireCertificate;
        https.CheckCertificateRevocation = false;
        https.HandshakeTimeout = TimeSpan.FromSeconds(10);
        // The chain is self-signed by design; only the key counts.
        https.ClientCertificateValidation = (client, _, _) => devices.Find(client) is not null;
    }
}
