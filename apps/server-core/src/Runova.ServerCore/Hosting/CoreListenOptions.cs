using System.Globalization;

namespace Runova.ServerCore.Hosting;

/// <summary>
/// Where the core listens. Production is a Unix socket only; loopback TCP exists for development
/// on machines without systemd. Nothing here can make the core listen on a public interface.
/// </summary>
internal sealed record CoreListenOptions(string? SocketPath, int? TcpPort)
{
    public const string SectionName = "Core:Listen";
    public static string DefaultSocketPath => CoreLayout.Current.SocketPath;
    public const int DefaultDevelopmentPort = 7810;

    public static CoreListenOptions From(IConfiguration configuration, bool isLinux)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        var section = configuration.GetSection(SectionName);

        var port = section["TcpPort"];
        if (!string.IsNullOrWhiteSpace(port))
        {
            if (!int.TryParse(port, NumberStyles.None, CultureInfo.InvariantCulture, out var value)
                || value is < 1 or > 65535)
            {
                throw new InvalidOperationException(
                    $"{SectionName}:TcpPort must be a port number from 1 to 65535, not '{port}'.");
            }

            return new CoreListenOptions(null, value);
        }

        var socket = section["SocketPath"];
        if (!string.IsNullOrWhiteSpace(socket))
        {
            if (!IsAbsolutePosixPath(socket))
            {
                throw new InvalidOperationException(
                    $"{SectionName}:SocketPath must be an absolute path without '..', not '{socket}'.");
            }

            return new CoreListenOptions(socket, null);
        }

        return isLinux
            ? new CoreListenOptions(DefaultSocketPath, null)
            : new CoreListenOptions(null, DefaultDevelopmentPort);
    }

    private static bool IsAbsolutePosixPath(string path) =>
        path.StartsWith('/') && !path.Split('/').Contains("..");
}
