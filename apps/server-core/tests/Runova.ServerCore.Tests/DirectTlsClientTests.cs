namespace Runova.ServerCore.Tests;

/// <summary>
/// The test ports of the direct TLS tests. A port from bind(0) comes from the OS's dynamic range,
/// so in the second between picking it and binding it, any outgoing connection (from this test or a
/// parallel one) can take it as its source port and the bind fails. The picked ports must come from
/// below that range, where the OS never hands one out on its own.
/// </summary>
public sealed class DirectTlsClientTests
{
    [Fact]
    public void Free_ports_are_unique_and_outside_the_range_the_os_hands_out()
    {
        var firstDynamic = FirstDynamicPort();

        var ports = Enumerable.Range(0, 50).Select(_ => DirectTlsClient.FreePort()).ToList();

        Assert.Equal(ports.Count, ports.Distinct().Count());
        Assert.All(ports, port => Assert.InRange(port, 1025, firstDynamic - 1));
    }

    private static int FirstDynamicPort()
    {
        const string linuxRange = "/proc/sys/net/ipv4/ip_local_port_range";
        if (OperatingSystem.IsLinux() && File.Exists(linuxRange))
        {
            return int.Parse(File.ReadAllText(linuxRange).Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)[0], System.Globalization.CultureInfo.InvariantCulture);
        }

        // The IANA dynamic range, which Windows and macOS use by default.
        return 49152;
    }
}
