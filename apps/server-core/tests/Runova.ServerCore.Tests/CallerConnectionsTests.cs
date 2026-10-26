using System.Net;
using Runova.ServerCore.Firewall;

namespace Runova.ServerCore.Tests;

/// <summary>
/// A firewall change must be confirmed over a new SSH connection, and the lockout guard wants
/// this computer's address as the server sees it. Both come from the process on the other end of
/// the core's socket: sshd's session process (a stream-local tunnel) or a bridge it started.
/// </summary>
public sealed class CallerConnectionsTests
{
    private static readonly int[] _ssh = [22];

    /// <summary>
    /// /proc/net/tcp as the kernel writes it: 0100007F:1F90 is 127.0.0.1:8080 (each 32-bit word
    /// little-endian, the port big-endian), state 01 is established and 0A listening.
    /// </summary>
    private const string Tcp =
        "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
        + "   0: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 652332 1 ffff8b0bf4394a00 100 0 0 10 0\n"
        + "   1: 0A0200C0:0016 3271CBCB:C822 01 00000000:00000000 02:0009A1F6 00000000     0        0 900001 2 ffff8b0bf4394a01 20 4 31 10 -1\n"
        + "   2: 0A0200C0:9C40 0A0200C0:1538 01 00000000:00000000 00:00000000 00000000  1000        0 900002 1 ffff8b0bf4394a02 20 4 31 10 -1\n"
        + "   3: 0A0200C0:0016 3271CBCB:C828 01 00000000:00000000 02:0009A1F6 00000000     0        0 900003 2 ffff8b0bf4394a03 20 4 31 10 -1\n";

    private const string Tcp6 =
        "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
        + "   0: 00000000000000000000000000000000:0016 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 651399 1 ffff8b0d5a4ceb40 100 0 0 10 0\n"
        + "   1: 0000000000000000FFFF00000A0200C0:0016 0000000000000000FFFF00003271CBCB:D000 01 00000000:00000000 00:00000000 00000000     0        0 900004 1 ffff8b0d5a4ceb41 20 4 31 10 -1\n"
        + "   2: B80D0120000000000000000001000000:0016 B80D0120000000000000000007000000:9C41 01 00000000:00000000 00:00000000 00000000     0        0 900005 1 ffff8b0d5a4ceb42 20 4 31 10 -1\n";

    [Fact]
    public void Proc_net_tcp_is_read_into_endpoints()
    {
        var entries = ProcNet.ParseTcp(Tcp);

        Assert.Equal(4, entries.Count);
        Assert.Equal(new IPEndPoint(IPAddress.Any, 22), entries[0].Local);
        Assert.False(entries[0].Established);
        Assert.Equal(new IPEndPoint(IPAddress.Parse("192.0.2.10"), 22), entries[1].Local);
        Assert.Equal(new IPEndPoint(IPAddress.Parse("203.203.113.50"), 51234), entries[1].Remote);
        Assert.True(entries[1].Established);
        Assert.Equal(900001, entries[1].Inode);
    }

    [Fact]
    public void Proc_net_tcp6_is_read_and_mapped_ipv4_comes_out_plain()
    {
        var entries = ProcNet.ParseTcp(Tcp6);

        Assert.Equal(IPAddress.IPv6Any, entries[0].Local.Address);
        Assert.Equal(new IPEndPoint(IPAddress.Parse("203.203.113.50"), 53248), entries[1].Remote);
        Assert.Equal(new IPEndPoint(IPAddress.Parse("2001:db8::1"), 22), entries[2].Local);
        Assert.Equal(new IPEndPoint(IPAddress.Parse("2001:db8::7"), 40001), entries[2].Remote);
    }

    [Theory]
    [InlineData("501 (sshd: deployer@notty) S 500 501 501 0 -1 4194560", 500)]
    [InlineData("777 (runova-core) S 776 777 777 0 -1", 776)]
    [InlineData("42 (a (strange) name) R 7 42 42 0 -1", 7)]
    [InlineData("garbage", null)]
    [InlineData(null, null)]
    public void The_parent_comes_from_stat_whatever_the_command_is_called(string? stat, int? parent) =>
        Assert.Equal(parent, ProcNet.ParentPid(stat));

    [Fact]
    public void A_tunnel_is_the_sshd_session_process_itself()
    {
        var table = new FakeProcessTable().Process(501, parent: 500, sockets: [900001]);

        var ssh = new LinuxCallerConnections(table).SshConnectionOf(501, _ssh);

        Assert.NotNull(ssh);
        Assert.Equal(IPAddress.Parse("203.203.113.50"), ssh.Client);
        Assert.Equal(51234, ssh.ClientPort);
        Assert.Equal(IPAddress.Parse("192.0.2.10"), ssh.Server);
        Assert.Equal(22, ssh.ServerPort);
    }

    [Fact]
    public void A_bridge_leads_up_through_its_shell_to_the_sshd_session()
    {
        var table = new FakeProcessTable()
            .Process(777, parent: 776, sockets: [123456])
            .Process(776, parent: 501, sockets: [])
            .Process(501, parent: 500, sockets: [900003]);

        var ssh = new LinuxCallerConnections(table).SshConnectionOf(777, _ssh);

        Assert.Equal(51240, ssh?.ClientPort);
    }

    [Fact]
    public void A_forward_on_the_same_session_is_not_taken_for_the_ssh_connection()
    {
        // The session holds its SSH connection and a -L forward it opened to port 5432.
        var table = new FakeProcessTable().Process(501, parent: 500, sockets: [900002, 900001]);

        Assert.Equal(51234, new LinuxCallerConnections(table).SshConnectionOf(501, _ssh)?.ClientPort);
        Assert.Null(new LinuxCallerConnections(table).SshConnectionOf(501, []));
    }

    [Fact]
    public void One_connection_is_taken_even_when_sshds_ports_are_unknown()
    {
        var table = new FakeProcessTable().Process(501, parent: 500, sockets: [900001]);

        Assert.Equal(51234, new LinuxCallerConnections(table).SshConnectionOf(501, [])?.ClientPort);
    }

    [Fact]
    public void An_ipv6_client_is_found_in_tcp6()
    {
        var table = new FakeProcessTable().Process(501, parent: 500, sockets: [900005]);

        var ssh = new LinuxCallerConnections(table).SshConnectionOf(501, _ssh);

        Assert.Equal(IPAddress.Parse("2001:db8::7"), ssh?.Client);
    }

    [Fact]
    public void The_walk_stops_at_init_and_after_a_few_parents()
    {
        var orphan = new FakeProcessTable().Process(901, parent: 1, sockets: []).Process(1, parent: 0, sockets: [900001]);
        var deep = new FakeProcessTable();
        for (var pid = 100; pid < 110; pid++)
        {
            deep.Process(pid, parent: pid + 1, sockets: []);
        }

        deep.Process(110, parent: 1, sockets: [900001]);

        Assert.Null(new LinuxCallerConnections(orphan).SshConnectionOf(901, _ssh));
        Assert.Null(new LinuxCallerConnections(deep).SshConnectionOf(100, _ssh));
    }

    [Fact]
    public void Without_a_unix_socket_the_transport_connection_is_all_there_is()
    {
        var caller = new LinuxCallerConnections(new FakeProcessTable()).Identify(http: null, "hub-connection-7", _ssh);

        Assert.Null(caller.Ssh);
        Assert.Equal("hub hub-connection-7", caller.Transport);
        Assert.Equal(caller.Transport, caller.Key);
    }

    private sealed class FakeProcessTable : IProcessTable
    {
        private readonly Dictionary<int, (int Parent, long[] Sockets)> _processes = [];

        public FakeProcessTable Process(int pid, int parent, long[] sockets)
        {
            _processes[pid] = (parent, sockets);
            return this;
        }

        public int? ParentOf(int pid) => _processes.TryGetValue(pid, out var process) ? process.Parent : null;

        public IReadOnlyCollection<long> SocketInodes(int pid) => _processes.TryGetValue(pid, out var process) ? process.Sockets : [];

        public IReadOnlyList<TcpEntry> TcpOf(int pid) => [.. ProcNet.ParseTcp(Tcp), .. ProcNet.ParseTcp(Tcp6)];
    }
}
