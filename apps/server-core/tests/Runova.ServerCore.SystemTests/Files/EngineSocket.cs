using System.IO.Pipes;
using System.Net.Sockets;

namespace Runova.ServerCore.SystemTests.Files;

/// <summary>
/// Where the real engine answers over a Unix socket, which is all the core's client speaks. On
/// Linux that is /var/run/docker.sock. Docker Desktop on Windows listens on a named pipe instead,
/// so this relays a Unix socket in the temp folder to the pipe, a connection at a time, both ways.
/// </summary>
internal sealed class EngineSocket : IAsyncDisposable
{
    private const string LinuxSocket = "/var/run/docker.sock";
    private const string WindowsPipe = "docker_engine";

    private readonly Socket? _listener;
    private readonly CancellationTokenSource _stop = new();
    private readonly Task _accepting = Task.CompletedTask;

    private EngineSocket(Uri endpoint, Socket? listener, string? path)
    {
        Endpoint = endpoint;
        _listener = listener;
        Path = path;
        if (listener is not null)
        {
            _accepting = AcceptAsync(listener, _stop.Token);
        }
    }

    public Uri Endpoint { get; }

    private string? Path { get; }

    public static EngineSocket Open()
    {
        if (!OperatingSystem.IsWindows())
        {
            return new EngineSocket(new Uri("unix://" + LinuxSocket), null, null);
        }

        var path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"am-docker-{Guid.NewGuid():N}"[..20] + ".sock");
        var listener = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
        listener.Bind(new UnixDomainSocketEndPoint(path));
        listener.Listen(64);
        return new EngineSocket(new Uri("unix:///" + path.Replace('\\', '/')), listener, path);
    }

    public async ValueTask DisposeAsync()
    {
        await _stop.CancelAsync();
        _listener?.Dispose();
        try
        {
            await _accepting;
        }
        catch (Exception error) when (error is OperationCanceledException or SocketException or ObjectDisposedException)
        {
            // Stopped.
        }

        if (Path is not null)
        {
            File.Delete(Path);
        }

        _stop.Dispose();
    }

    private static async Task AcceptAsync(Socket listener, CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            var client = await listener.AcceptAsync(cancellationToken);
            _ = RelayAsync(client, cancellationToken);
        }
    }

    private static async Task RelayAsync(Socket client, CancellationToken cancellationToken)
    {
        using (client)
        await using (var pipe = new NamedPipeClientStream(".", WindowsPipe, PipeDirection.InOut, PipeOptions.Asynchronous))
        await using (var socket = new NetworkStream(client, ownsSocket: false))
        {
            try
            {
                await pipe.ConnectAsync(5000, cancellationToken);
                var up = CopyAsync(socket, pipe, cancellationToken);
                var down = CopyAsync(pipe, socket, cancellationToken);
                // Either side ending ends the connection, as closing a Unix socket would: a client
                // that drops a request half sent must not leave the engine waiting for the rest.
                if (await Task.WhenAny(up, down) == down)
                {
                    client.Shutdown(SocketShutdown.Send);
                }
            }
            catch (Exception error) when (error is IOException or SocketException or OperationCanceledException or ObjectDisposedException or TimeoutException)
            {
                // One side went away.
            }
        }
    }

    private static async Task CopyAsync(Stream from, Stream to, CancellationToken cancellationToken)
    {
        var buffer = new byte[256 * 1024];
        int read;
        while ((read = await from.ReadAsync(buffer, cancellationToken)) > 0)
        {
            await to.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
            await to.FlushAsync(cancellationToken);
        }
    }
}
