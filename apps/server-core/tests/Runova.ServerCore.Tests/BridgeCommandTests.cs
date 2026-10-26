using System.Net.Sockets;
using System.Text;
using Runova.ServerCore.Cli;

namespace Runova.ServerCore.Tests;

/// <summary>
/// When sshd forbids stream-local forwarding, the app runs `runova-core bridge` over an SSH exec
/// channel instead: stdin goes to the core's socket and the socket's answers come back on stdout.
/// It runs as the SSH user, so it never reads the root-only configuration.
/// </summary>
public sealed class BridgeCommandTests : IDisposable
{
    private readonly string _directory = Path.Combine(Path.GetTempPath(), $"bridge-{Guid.NewGuid():N}");

    [Fact]
    public async Task Relays_bytes_both_ways_between_stdio_and_the_socket()
    {
        var socketPath = Path.Combine(_directory, "core.sock");
        using var listener = Listen(socketPath);
        var echo = EchoOnceAsync(listener);
        using var stdin = new MemoryStream(Encoding.UTF8.GetBytes("GET /api/v1/health"));
        using var stdout = new MemoryStream();

        var exitCode = await BridgeCommand.RunAsync(
            ["--socket", socketPath],
            stdin,
            stdout,
            TextWriter.Null,
            TestContext.Current.CancellationToken);

        await echo;
        Assert.Equal(0, exitCode);
        Assert.Equal("GET /api/v1/health", Encoding.UTF8.GetString(stdout.ToArray()));
    }

    [Fact]
    public async Task Explains_a_core_that_is_not_running()
    {
        Directory.CreateDirectory(_directory);
        using var error = new StringWriter();

        var exitCode = await BridgeCommand.RunAsync(
            ["--socket", Path.Combine(_directory, "missing.sock")],
            Stream.Null,
            Stream.Null,
            error,
            TestContext.Current.CancellationToken);

        Assert.Equal(3, exitCode);
        Assert.Contains("is the service running", error.ToString(), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("--socket")]
    [InlineData("--socket", "relative/core.sock")]
    [InlineData("--unexpected")]
    public async Task Refuses_arguments_it_does_not_understand(params string[] args)
    {
        using var error = new StringWriter();

        var exitCode = await BridgeCommand.RunAsync(
            args,
            Stream.Null,
            Stream.Null,
            error,
            TestContext.Current.CancellationToken);

        Assert.Equal(2, exitCode);
        Assert.Contains("Usage", error.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void Uses_the_managed_socket_by_default()
    {
        Assert.Equal("/run/runova-core/core.sock", BridgeCommand.DefaultSocketPath);
    }

    [Fact]
    public async Task The_entry_point_sends_bridge_to_the_bridge_and_not_the_web_host()
    {
        Directory.CreateDirectory(_directory);

        var exitCode = await CoreEntryPoint.RunAsync(
            ["bridge", "--socket", Path.Combine(_directory, "missing.sock")],
            TextWriter.Null,
            TextWriter.Null,
            _ => throw new InvalidOperationException("The web host must not start for the bridge."));

        Assert.Equal(3, exitCode);
    }

    public void Dispose()
    {
        if (Directory.Exists(_directory))
        {
            Directory.Delete(_directory, recursive: true);
        }
    }

    private Socket Listen(string path)
    {
        Directory.CreateDirectory(_directory);
        var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
        socket.Bind(new UnixDomainSocketEndPoint(path));
        socket.Listen();
        return socket;
    }

    /// <summary>Accepts one connection and echoes everything back until the client stops sending.</summary>
    private static async Task EchoOnceAsync(Socket listener)
    {
        using var connection = await listener.AcceptAsync(TestContext.Current.CancellationToken);
        var buffer = new byte[4096];
        while (true)
        {
            var read = await connection.ReceiveAsync(buffer, SocketFlags.None, TestContext.Current.CancellationToken);
            if (read == 0)
            {
                break;
            }

            await connection.SendAsync(buffer.AsMemory(0, read), SocketFlags.None, TestContext.Current.CancellationToken);
        }

        connection.Shutdown(SocketShutdown.Send);
    }
}
