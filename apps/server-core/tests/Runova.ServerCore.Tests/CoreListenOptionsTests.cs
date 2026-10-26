using Microsoft.Extensions.Configuration;
using Runova.ServerCore.Hosting;

namespace Runova.ServerCore.Tests;

/// <summary>
/// Production listens on a Unix socket only. Loopback TCP exists for development on machines
/// without systemd, and nothing can make the core listen on a public interface.
/// </summary>
public sealed class CoreListenOptionsTests
{
    [Fact]
    public void Linux_defaults_to_the_managed_socket()
    {
        var options = CoreListenOptions.From(Configuration(), isLinux: true);

        Assert.Equal("/run/runova-core/core.sock", options.SocketPath);
        Assert.Null(options.TcpPort);
    }

    [Fact]
    public void Other_platforms_default_to_loopback_tcp_for_development()
    {
        var options = CoreListenOptions.From(Configuration(), isLinux: false);

        Assert.Null(options.SocketPath);
        Assert.Equal(CoreListenOptions.DefaultDevelopmentPort, options.TcpPort);
    }

    [Fact]
    public void A_configured_socket_path_is_used()
    {
        var options = CoreListenOptions.From(
            Configuration(("Core:Listen:SocketPath", "/tmp/runova-test/core.sock")),
            isLinux: true);

        Assert.Equal("/tmp/runova-test/core.sock", options.SocketPath);
    }

    [Fact]
    public void A_configured_port_switches_to_loopback_tcp()
    {
        var options = CoreListenOptions.From(Configuration(("Core:Listen:TcpPort", "18080")), isLinux: true);

        Assert.Null(options.SocketPath);
        Assert.Equal(18080, options.TcpPort);
    }

    [Theory]
    [InlineData("0")]
    [InlineData("65536")]
    [InlineData("eighty")]
    public void An_invalid_port_is_rejected(string port)
    {
        var error = Assert.Throws<InvalidOperationException>(() =>
            CoreListenOptions.From(Configuration(("Core:Listen:TcpPort", port)), isLinux: true));

        Assert.Contains("TcpPort", error.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("core.sock")]
    [InlineData("../run/core.sock")]
    public void A_relative_socket_path_is_rejected(string path)
    {
        var error = Assert.Throws<InvalidOperationException>(() =>
            CoreListenOptions.From(Configuration(("Core:Listen:SocketPath", path)), isLinux: true));

        Assert.Contains("absolute", error.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("http://unix:/run/runova-core/core.sock", "/run/runova-core/core.sock")]
    [InlineData("http://127.0.0.1:7810", null)]
    public void Kestrel_socket_addresses_are_recognized(string address, string? expected)
    {
        Assert.Equal(expected, UnixSocketFile.PathFromServerAddress(address));
    }

    private static IConfiguration Configuration(params (string Key, string Value)[] values) =>
        new ConfigurationBuilder()
            .AddInMemoryCollection(values.Select(pair => new KeyValuePair<string, string?>(pair.Key, pair.Value)))
            .Build();
}
