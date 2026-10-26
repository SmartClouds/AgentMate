using System.Net.Sockets;
using System.Runtime.InteropServices;
using Microsoft.AspNetCore.Connections.Features;

namespace Runova.ServerCore.Security;

/// <summary>
/// Which Unix user is on the other end of the socket (SO_PEERCRED): the SSH login the tunnel or the
/// bridge runs as. Recorded in the audit trail. Unknown over TCP (the DevHost, tests) and off Linux.
/// </summary>
internal static class PeerCredentials
{
    private const int SolSocket = 1;
    private const int SoPeerCred = 17;

    public static int? UidOf(HttpContext? context) => Read(context)?.Uid;

    /// <summary>
    /// The process that connected: sshd's session process for a stream-local tunnel, the bridge
    /// otherwise. The firewall walks up from it to the SSH connection the call came over.
    /// </summary>
    public static int? PidOf(HttpContext? context) => Read(context)?.Pid;

    private static (int Pid, int Uid)? Read(HttpContext? context)
    {
        if (context is null || !OperatingSystem.IsLinux())
        {
            return null;
        }

        var socket = context.Features.Get<IConnectionSocketFeature>()?.Socket;
        if (socket is null || socket.AddressFamily != AddressFamily.Unix)
        {
            return null;
        }

        // struct ucred { pid_t pid; uid_t uid; gid_t gid; }
        Span<byte> credentials = stackalloc byte[12];
        try
        {
            return socket.GetRawSocketOption(SolSocket, SoPeerCred, credentials) >= 8
                ? (MemoryMarshal.Read<int>(credentials[..4]), MemoryMarshal.Read<int>(credentials[4..8]))
                : null;
        }
        catch (SocketException)
        {
            return null;
        }
    }
}
