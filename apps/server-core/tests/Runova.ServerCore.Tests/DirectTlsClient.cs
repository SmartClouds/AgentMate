using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Runova.ServerCore.DirectTls;

namespace Runova.ServerCore.Tests;

/// <summary>
/// The test side of a direct TLS connection: a client certificate self-signed with a device key (as
/// the desktop makes one) and an HttpClient that checks the server's key against a pin.
/// </summary>
internal static class DirectTlsClient
{
    private const int FirstPort = 20000;

    private const int PortCount = 12000;

    private static readonly Lock _portGate = new();

    private static int _nextPort = Random.Shared.Next(PortCount);

    /// <summary>A self-signed client certificate for a key, usable by SslStream on every OS.</summary>
    public static X509Certificate2 CertificateFor(ECDsa key)
    {
        var request = new CertificateRequest("CN=runova-device", key, HashAlgorithmName.SHA256);
        request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension([new Oid("1.3.6.1.5.5.7.3.2")], false));
        using var created = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-5), DateTimeOffset.UtcNow.AddDays(1));
        return X509CertificateLoader.LoadPkcs12(created.Export(X509ContentType.Pkcs12), password: null);
    }

    /// <summary>
    /// Requests to https://127.0.0.1:port with the Host header the app sends. The handler refuses a
    /// server whose key does not hash to the pin; `seenPin` reports the server's actual pin. Without
    /// keepAlive every request opens a new connection.
    /// </summary>
    public static HttpClient Create(int port, string pin, X509Certificate2? clientCertificate, Action<string>? seenPin = null, bool keepAlive = false)
    {
        var handler = new SocketsHttpHandler
        {
            PooledConnectionLifetime = keepAlive ? Timeout.InfiniteTimeSpan : TimeSpan.Zero,
            SslOptions = new SslClientAuthenticationOptions
            {
                TargetHost = "runova-core",
                EnabledSslProtocols = System.Security.Authentication.SslProtocols.Tls13,
                ClientCertificates = clientCertificate is null ? null : new X509CertificateCollection { clientCertificate },
                LocalCertificateSelectionCallback = (_, _, _, _, _) => clientCertificate!,
                RemoteCertificateValidationCallback = (_, certificate, _, _) =>
                {
                    if (certificate is null)
                    {
                        return false;
                    }

                    using var server = X509CertificateLoader.LoadCertificate(certificate.GetRawCertData());
                    var actual = DirectTlsCertificate.PinOf(server);
                    seenPin?.Invoke(actual);
                    return actual == pin;
                },
            },
        };
        return new HttpClient(handler, disposeHandler: true)
        {
            BaseAddress = new Uri($"https://127.0.0.1:{port}"),
            DefaultRequestHeaders = { Host = "runova-core" },
            Timeout = TimeSpan.FromSeconds(15),
        };
    }

    /// <summary>
    /// A loopback port nothing is bound to, never the same one twice in this process. It comes from
    /// below the OS's dynamic range (32768 and up on Linux, 49152 and up on Windows and macOS). A
    /// port from bind(0) comes from that range, so before the test binds it, any outgoing connection
    /// can take it as its source port. Below the range only an explicit bind takes a port. The start
    /// is random so two test runs on one machine rarely walk the same ports.
    /// </summary>
    public static int FreePort()
    {
        lock (_portGate)
        {
            for (var tried = 0; tried < PortCount; tried++)
            {
                var port = FirstPort + _nextPort;
                _nextPort = (_nextPort + 1) % PortCount;
                if (CanBind(port))
                {
                    return port;
                }
            }
        }

        throw new InvalidOperationException($"No free loopback port from {FirstPort} to {FirstPort + PortCount - 1}.");
    }

    private static bool CanBind(int port)
    {
        var listener = new TcpListener(IPAddress.Loopback, port);
        try
        {
            listener.Start();
            return true;
        }
        catch (SocketException)
        {
            // Taken, or reserved by Windows (Hyper-V keeps blocks of ports).
            return false;
        }
        finally
        {
            listener.Stop();
        }
    }

    public static bool Accepts(int port)
    {
        using var client = new TcpClient();
        try
        {
            client.Connect(IPAddress.Loopback, port);
            return true;
        }
        catch (SocketException)
        {
            return false;
        }
    }
}
