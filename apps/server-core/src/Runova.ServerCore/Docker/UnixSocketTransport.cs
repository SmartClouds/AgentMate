using System.Net.Sockets;
using Docker.DotNet.Handler.Abstractions;
using Microsoft.Net.Http.Client;

namespace Runova.ServerCore.Docker;

/// <summary>
/// Docker.DotNet's HTTP handler over a Unix socket, connected with the BCL's
/// UnixDomainSocketEndPoint. The library's own endpoint class never connects on Windows, where the
/// tests run against the fake engine too; this one works on both. Upgraded connections (docker
/// exec) are handed over the same way the library's Unix transport does it.
/// </summary>
internal sealed class UnixSocketTransport : IDockerHandlerFactory<string>
{
    public static readonly UnixSocketTransport Instance = new();

    private UnixSocketTransport()
    {
    }

    public ResolvedTransport CreateHandler(ResolvedClientOptions clientOptions, ILogger logger) =>
        throw new NotSupportedException("The socket path is the transport option.");

    public ResolvedTransport CreateHandler(string transportOptions, ResolvedClientOptions clientOptions, ILogger logger)
    {
        var socketPath = transportOptions;
        var handler = new ManagedHandler(
            async (_, _, cancellationToken) =>
            {
                var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
                try
                {
                    await socket.ConnectAsync(new UnixDomainSocketEndPoint(socketPath), cancellationToken);
                    return socket;
                }
                catch
                {
                    socket.Dispose();
                    throw;
                }
            },
            logger);
        return new ResolvedTransport(handler, new Uri("http://docker/"));
    }

    public Task<WriteClosableStream> HijackStreamAsync(HttpContent content) =>
        content is HttpConnectionResponseContent hijackable
            ? Task.FromResult(hijackable.HijackStream())
            : throw new NotSupportedException("This response cannot be taken over as a raw stream.");
}
