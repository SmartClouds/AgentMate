namespace Runova.ServerCore.ErrorReporting;

/// <summary>
/// The network the exporter talks through. The core uses real sockets; tests swap in a fake Sentry so
/// no test ever leaves the machine.
/// </summary>
internal interface IErrorReportingTransport
{
    HttpMessageHandler CreateHandler();
}

/// <summary>
/// Real sockets, with redirects off: the DSN's host is the one place the key may go, and a redirect
/// could move it somewhere else.
/// </summary>
internal sealed class SocketsErrorReportingTransport : IErrorReportingTransport
{
    public HttpMessageHandler CreateHandler() => new SocketsHttpHandler
    {
        AllowAutoRedirect = false,
        ConnectTimeout = TimeSpan.FromSeconds(10),
        PooledConnectionLifetime = TimeSpan.FromMinutes(5),
    };
}
