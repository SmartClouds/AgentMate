using System.Net.Sockets;
using Runova.ServerCore.Hosting;

namespace Runova.ServerCore.Cli;

/// <summary>
/// `runova-core bridge`: joins stdin and stdout to the core's Unix socket. The app runs it over
/// an SSH exec channel when sshd forbids stream-local forwarding, so it runs as the SSH user (a
/// member of the runova group) and never loads the root-only configuration.
/// </summary>
internal static class BridgeCommand
{
    /// <summary>The socket of the layout this copy of the program was started from.</summary>
    public static string DefaultSocketPath => CoreLayout.Current.SocketPath;

    private const string Usage = "Usage: runova-core bridge [--socket <absolute path>]";
    private const int BufferBytes = 64 * 1024;

    public static async Task<int> RunAsync(
        string[] args,
        Stream stdin,
        Stream stdout,
        TextWriter error,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(args);
        ArgumentNullException.ThrowIfNull(stdin);
        ArgumentNullException.ThrowIfNull(stdout);
        ArgumentNullException.ThrowIfNull(error);

        string socketPath;
        switch (args)
        {
            case []:
                socketPath = DefaultSocketPath;
                break;
            case ["--socket", var path] when Path.IsPathFullyQualified(path) || path.StartsWith('/'):
                socketPath = path;
                break;
            default:
                await error.WriteLineAsync(Usage);
                return 2;
        }

        using var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
        try
        {
            await socket.ConnectAsync(new UnixDomainSocketEndPoint(socketPath), cancellationToken);
        }
        catch (SocketException exception)
        {
            await error.WriteLineAsync(
                $"Cannot reach the Runova core at {socketPath} ({exception.SocketErrorCode}): is the service running?");
            return 3;
        }

        await using var peer = new NetworkStream(socket, ownsSocket: false);
        var upstream = RelayUpAsync(stdin, peer, socket, cancellationToken);
        var downstream = RelayDownAsync(peer, stdout, cancellationToken);

        // The core ends the conversation. The client closing stdin only means it has nothing more
        // to send; the answer may still be on its way.
        await downstream;
        await Task.WhenAny(upstream, Task.Delay(TimeSpan.FromSeconds(1), cancellationToken));
        return 0;
    }

    private static async Task RelayUpAsync(Stream stdin, Stream peer, Socket socket, CancellationToken cancellationToken)
    {
        try
        {
            await stdin.CopyToAsync(peer, BufferBytes, cancellationToken);
            socket.Shutdown(SocketShutdown.Send);
        }
        catch (Exception exception) when (exception is IOException or SocketException or ObjectDisposedException)
        {
            // The core went away first; the downstream side reports the end.
        }
    }

    private static async Task RelayDownAsync(Stream peer, Stream stdout, CancellationToken cancellationToken)
    {
        try
        {
            await peer.CopyToAsync(stdout, BufferBytes, cancellationToken);
        }
        catch (Exception exception) when (exception is IOException or SocketException)
        {
            // The connection dropped; there is nothing left to relay.
        }

        await stdout.FlushAsync(cancellationToken);
    }
}
