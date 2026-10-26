using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;

namespace Runova.ServerCore.Tests;

/// <summary>
/// Leaves a socket file behind the way a crashed process does. .NET unlinks the path when a bound
/// socket is disposed, so this goes straight to libc: bind, then close without unlinking.
/// </summary>
[SupportedOSPlatform("linux")]
internal static partial class StaleUnixSocket
{
    private const int AfUnix = 1;
    private const int SockStream = 1;

    public static void Create(string path)
    {
        var descriptor = Socket(AfUnix, SockStream, 0);
        if (descriptor < 0)
        {
            throw new InvalidOperationException($"socket() failed with errno {Marshal.GetLastPInvokeError()}.");
        }

        try
        {
            var address = Address(path);
            if (Bind(descriptor, address, address.Length) != 0)
            {
                throw new InvalidOperationException($"bind() failed with errno {Marshal.GetLastPInvokeError()}.");
            }
        }
        finally
        {
            _ = Close(descriptor);
        }
    }

    /// <summary>A sockaddr_un: the address family, then the NUL-terminated path.</summary>
    private static byte[] Address(string path)
    {
        var pathBytes = Encoding.UTF8.GetBytes(path);
        var address = new byte[2 + pathBytes.Length + 1];
        BitConverter.GetBytes((ushort)AfUnix).CopyTo(address, 0);
        pathBytes.CopyTo(address, 2);
        return address;
    }

    [LibraryImport("libc", EntryPoint = "socket", SetLastError = true)]
    private static partial int Socket(int domain, int type, int protocol);

    [LibraryImport("libc", EntryPoint = "bind", SetLastError = true)]
    private static partial int Bind(int descriptor, byte[] address, int length);

    [LibraryImport("libc", EntryPoint = "close", SetLastError = true)]
    private static partial int Close(int descriptor);
}
