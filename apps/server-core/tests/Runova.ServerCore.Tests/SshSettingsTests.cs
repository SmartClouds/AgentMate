using System.Net;
using Runova.ServerCore.Firewall;

namespace Runova.ServerCore.Tests;

/// <summary>
/// The lockout guard needs to know how this computer reaches SSH: the desktop sends the
/// `$SSH_CONNECTION` its session sees, and the core asks sshd which ports it listens on
/// (`sshd -T`, captured from Ubuntu 24.04 and Rocky 9 in Fixtures/sshd).
/// </summary>
public sealed class SshSettingsTests
{
    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    [Theory]
    [InlineData("203.0.113.50 51234 192.0.2.10 22", "203.0.113.50", 51234, "192.0.2.10", 22)]
    [InlineData("2001:db8::7 40022 2001:db8::1 2222", "2001:db8::7", 40022, "2001:db8::1", 2222)]
    [InlineData("::ffff:203.0.113.50 51234 ::ffff:192.0.2.10 22", "203.0.113.50", 51234, "192.0.2.10", 22)]
    [InlineData("fe80::1%eth0 51234 fe80::2%eth0 22", "fe80::1", 51234, "fe80::2", 22)]
    [InlineData("  203.0.113.50   51234 192.0.2.10 22\n", "203.0.113.50", 51234, "192.0.2.10", 22)]
    public void Ssh_connection_is_read_as_sshd_writes_it(string text, string client, int clientPort, string server, int serverPort)
    {
        Assert.True(SshEndpoint.TryParse(text, out var endpoint));
        Assert.Equal(IPAddress.Parse(client), endpoint.Client);
        Assert.Equal(clientPort, endpoint.ClientPort);
        Assert.Equal(IPAddress.Parse(server), endpoint.Server);
        Assert.Equal(serverPort, endpoint.ServerPort);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("203.0.113.50 51234 192.0.2.10")]
    [InlineData("203.0.113.50 51234 192.0.2.10 22 extra")]
    [InlineData("203.0.113.50 0 192.0.2.10 22")]
    [InlineData("203.0.113.50 51234 192.0.2.10 65536")]
    [InlineData("example.com 51234 192.0.2.10 22")]
    [InlineData("127.1 51234 192.0.2.10 22")]
    [InlineData("203.0.113.50 +22 192.0.2.10 22")]
    public void Anything_else_is_not_an_ssh_connection(string? text) =>
        Assert.False(SshEndpoint.TryParse(text, out _));

    [Fact]
    public void Two_connections_differ_by_their_client_port()
    {
        Assert.True(SshEndpoint.TryParse("203.0.113.50 51234 192.0.2.10 22", out var first));
        Assert.True(SshEndpoint.TryParse("203.0.113.50 51240 192.0.2.10 22", out var second));
        Assert.True(SshEndpoint.TryParse("203.0.113.50 51234 192.0.2.10 22", out var same));

        Assert.NotEqual(first.Key, second.Key);
        Assert.Equal(first.Key, same.Key);
    }

    [Theory]
    [InlineData("sshd/sshd-T-ubuntu-24.04.txt", new[] { 22 })]
    [InlineData("sshd/sshd-T-rocky-9.txt", new[] { 22 })]
    [InlineData("sshd/sshd-T-two-ports.txt", new[] { 22, 2222 })]
    public void Sshds_ports_come_from_its_effective_settings(string fixture, int[] ports) =>
        Assert.Equal(ports, SshdSettings.Ports(Fixtures.Read(fixture)));

    [Fact]
    public void A_listen_address_with_its_own_port_counts_too()
    {
        Assert.Equal([22, 2200, 2201], SshdSettings.Ports("port 22\nlistenaddress 10.0.0.5:2200\nlistenaddress [2001:db8::5]:2201\nlistenaddress 0.0.0.0:22\n"));
    }

    [Fact]
    public async Task Sshd_is_asked_and_a_failure_says_why()
    {
        var processes = new FakeProcessRunner();
        processes.Respond("sshd", ["-T"], _ => FakeProcessRunner.Ok(Fixtures.Read("sshd/sshd-T-two-ports.txt")));
        var failing = new FakeProcessRunner();
        failing.Respond("sshd", ["-T"], _ => FakeProcessRunner.Exit(255, error: "/etc/ssh/sshd_config line 3: Bad configuration option: Prot"));

        var ports = await new SshdSettings(processes).ReadAsync(Cancel);
        var broken = await new SshdSettings(failing).ReadAsync(Cancel);

        Assert.Equal([22, 2222], ports.Ports);
        Assert.Null(ports.Error);
        Assert.Empty(broken.Ports);
        Assert.Contains("Bad configuration option", broken.Error, StringComparison.Ordinal);
    }
}
