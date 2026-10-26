using System.Net.Sockets;
using System.Runtime.Versioning;

namespace Runova.ServerCore.Hosting;

/// <summary>
/// The socket file the app reaches through SSH. Only root and the runova group may open it, so
/// other local users and services (nginx included) are stopped by the kernel before any HTTP is
/// parsed.
/// </summary>
internal static class UnixSocketFile
{
    public const UnixFileMode SocketMode =
        UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead | UnixFileMode.GroupWrite;

    private const string AddressPrefix = "http://unix:";

    /// <summary>The socket path in a Kestrel listen address, or null for a TCP address.</summary>
    public static string? PathFromServerAddress(string address)
    {
        ArgumentNullException.ThrowIfNull(address);
        return address.StartsWith(AddressPrefix, StringComparison.Ordinal)
            ? address[AddressPrefix.Length..]
            : null;
    }

    /// <summary>
    /// Clears a socket file that a crashed run left behind, so the next start can bind, but never
    /// one that a live process is still serving.
    /// </summary>
    public static void PrepareForBind(string path)
    {
        ArgumentNullException.ThrowIfNull(path);
        var directory = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }

        if (!File.Exists(path))
        {
            return;
        }

        if (IsServing(path))
        {
            throw new InvalidOperationException(
                $"Another process is already serving {path}. Stop it before starting the core.");
        }

        File.Delete(path);
    }

    [UnsupportedOSPlatform("windows")]
    public static void RestrictPermissions(string path) => File.SetUnixFileMode(path, SocketMode);

    private static bool IsServing(string path)
    {
        using var probe = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
        try
        {
            probe.Connect(new UnixDomainSocketEndPoint(path));
            return true;
        }
        catch (SocketException)
        {
            return false;
        }
    }
}
