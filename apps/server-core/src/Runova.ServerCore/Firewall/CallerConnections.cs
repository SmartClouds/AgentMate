using System.Globalization;
using System.Net;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Firewall;

/// <summary>
/// The connection a hub call came over: the SSH connection when the core can tell, and the socket
/// connection to the core always. A firewall change records the one that applied it, so the
/// confirmation can be refused when it comes over the same one.
/// </summary>
internal sealed record CallerConnection(SshEndpoint? Ssh, string Transport)
{
    public string Key => Ssh?.Key ?? Transport;
}

/// <summary>Works out which connection a call came over.</summary>
internal interface ICallerConnections
{
    /// <param name="sshPorts">sshd's ports, to tell the SSH connection from a forward on the same session.</param>
    CallerConnection Identify(HttpContext? http, string hubConnectionId, IReadOnlyCollection<int> sshPorts);
}

/// <summary>One line of /proc/net/tcp or tcp6.</summary>
internal sealed record TcpEntry(IPEndPoint Local, IPEndPoint Remote, bool Established, long Inode);

/// <summary>What the walk needs of /proc, so tests can stand in for the kernel.</summary>
internal interface IProcessTable
{
    int? ParentOf(int pid);

    IReadOnlyCollection<long> SocketInodes(int pid);

    /// <summary>The process's view of /proc/net/tcp and tcp6 (its own network namespace).</summary>
    IReadOnlyList<TcpEntry> TcpOf(int pid);
}

/// <summary>/proc's formats: net/tcp lines and the parent in stat.</summary>
internal static class ProcNet
{
    private const string Established = "01";

    /// <summary>
    /// "0A0200C0:0016" is 192.0.2.10:22: each 32-bit word of the address is in the kernel's
    /// (little-endian) byte order, the port in network order. IPv4-mapped IPv6 comes out as IPv4.
    /// </summary>
    public static IReadOnlyList<TcpEntry> ParseTcp(string? text)
    {
        var entries = new List<TcpEntry>();
        if (string.IsNullOrEmpty(text))
        {
            return entries;
        }

        foreach (var line in text.Split('\n').Skip(1))
        {
            var fields = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (fields.Length < 10
                || ParseEndpoint(fields[1]) is not { } local
                || ParseEndpoint(fields[2]) is not { } remote
                || !long.TryParse(fields[9], NumberStyles.None, CultureInfo.InvariantCulture, out var inode))
            {
                continue;
            }

            entries.Add(new TcpEntry(local, remote, fields[3] == Established, inode));
        }

        return entries;
    }

    /// <summary>The fourth field of /proc/&lt;pid&gt;/stat, read after the command's closing parenthesis.</summary>
    public static int? ParentPid(string? stat)
    {
        var close = stat?.LastIndexOf(')') ?? -1;
        if (close < 0)
        {
            return null;
        }

        var fields = stat![(close + 1)..].Split(' ', StringSplitOptions.RemoveEmptyEntries);
        return fields.Length >= 2 && int.TryParse(fields[1], NumberStyles.None, CultureInfo.InvariantCulture, out var parent)
            ? parent
            : null;
    }

    private static IPEndPoint? ParseEndpoint(string text)
    {
        var colon = text.IndexOf(':', StringComparison.Ordinal);
        if (colon < 0
            || !int.TryParse(text[(colon + 1)..], NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out var port)
            || port > 65535)
        {
            return null;
        }

        var hex = text[..colon];
        if (hex.Length is not (8 or 32))
        {
            return null;
        }

        byte[] bytes;
        try
        {
            bytes = Convert.FromHexString(hex);
        }
        catch (FormatException)
        {
            return null;
        }

        for (var word = 0; word < bytes.Length; word += 4)
        {
            Array.Reverse(bytes, word, 4);
        }

        return new IPEndPoint(FirewallAddresses.Normalize(new IPAddress(bytes)), port);
    }
}

/// <summary>The real /proc. Reading another process's fd table needs root, which the core is.</summary>
internal sealed class LinuxProcessTable : IProcessTable
{
    public int? ParentOf(int pid) => ProcNet.ParentPid(Read($"/proc/{pid.ToString(CultureInfo.InvariantCulture)}/stat"));

    public IReadOnlyCollection<long> SocketInodes(int pid)
    {
        var inodes = new List<long>();
        try
        {
            foreach (var entry in Directory.EnumerateFileSystemEntries($"/proc/{pid.ToString(CultureInfo.InvariantCulture)}/fd"))
            {
                // Each entry is a link; a socket's reads "socket:[12345]".
                var target = new FileInfo(entry).LinkTarget;
                if (target is not null
                    && target.StartsWith("socket:[", StringComparison.Ordinal)
                    && target.EndsWith(']')
                    && long.TryParse(target["socket:[".Length..^1], NumberStyles.None, CultureInfo.InvariantCulture, out var inode))
                {
                    inodes.Add(inode);
                }
            }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            // The process is gone, or not ours to look at.
        }

        return inodes;
    }

    public IReadOnlyList<TcpEntry> TcpOf(int pid)
    {
        var root = $"/proc/{pid.ToString(CultureInfo.InvariantCulture)}/net";
        return [.. ProcNet.ParseTcp(Read($"{root}/tcp")), .. ProcNet.ParseTcp(Read($"{root}/tcp6"))];
    }

    private static string? Read(string path)
    {
        try
        {
            return File.ReadAllText(path);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }
}

/// <summary>
/// On the server the app reaches the core's Unix socket through sshd: either sshd's own session
/// process connects to it (stream-local forwarding) or a bridge it started does. SO_PEERCRED names
/// that process; walking up its parents to the first one holding an established TCP connection to
/// an SSH port finds the SSH connection itself, with this computer's address as the server sees it.
/// </summary>
internal sealed class LinuxCallerConnections(IProcessTable processes) : ICallerConnections
{
    public const int MaxDepth = 6;

    public CallerConnection Identify(HttpContext? http, string hubConnectionId, IReadOnlyCollection<int> sshPorts)
    {
        ArgumentNullException.ThrowIfNull(sshPorts);
        var transport = http?.Connection.Id is { Length: > 0 } connection ? $"connection {connection}" : $"hub {hubConnectionId}";
        var ssh = PeerCredentials.PidOf(http) is int pid ? SshConnectionOf(pid, sshPorts) : null;
        return new CallerConnection(ssh, transport);
    }

    /// <summary>The SSH connection behind a peer process, or null when it cannot be told for sure.</summary>
    public SshEndpoint? SshConnectionOf(int pid, IReadOnlyCollection<int> sshPorts)
    {
        ArgumentNullException.ThrowIfNull(sshPorts);
        var current = pid;
        for (var depth = 0; depth < MaxDepth && current > 1; depth++)
        {
            var inodes = processes.SocketInodes(current);
            if (inodes.Count > 0)
            {
                var held = processes.TcpOf(current).Where(entry => entry.Established && inodes.Contains(entry.Inode)).ToList();
                var candidates = sshPorts.Count > 0 ? held.Where(entry => sshPorts.Contains(entry.Local.Port)).ToList() : held;
                if (candidates.Count == 1)
                {
                    var entry = candidates[0];
                    return new SshEndpoint(entry.Remote.Address, entry.Remote.Port, entry.Local.Address, entry.Local.Port);
                }

                if (candidates.Count > 1)
                {
                    // Several connections and nothing to tell which is the SSH one.
                    return null;
                }
            }

            if (processes.ParentOf(current) is not int parent || parent <= 0)
            {
                return null;
            }

            current = parent;
        }

        return null;
    }
}
