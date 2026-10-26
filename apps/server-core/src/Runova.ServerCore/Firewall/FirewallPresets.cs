using System.Globalization;
using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.Firewall;

/// <summary>
/// Rules for the services people open most. SSH uses the ports sshd really listens on; database
/// ports are marked so the app asks for the addresses that need them instead of opening them to
/// everyone.
/// </summary>
internal static class FirewallPresets
{
    public static FirewallPreset[] For(IReadOnlyList<int> sshPorts)
    {
        ArgumentNullException.ThrowIfNull(sshPorts);
        int[] ports = sshPorts.Count > 0 ? [.. sshPorts] : [22];
        var named = string.Join(", ", ports.Select(port => port.ToString(CultureInfo.InvariantCulture)));
        return
        [
            new(
                "ssh",
                "SSH",
                $"Remote logins (port {named}). Keep it open: it is how this computer reaches the server.",
                [.. ports.Select(port => Tcp(port))],
                SuggestSource: false),
            new("http", "HTTP", "Websites over plain HTTP (port 80), and how Let's Encrypt checks a domain.", [Tcp(80)], SuggestSource: false),
            new("https", "HTTPS", "Websites over HTTPS (port 443).", [Tcp(443)], SuggestSource: false),
            new("mysql", "MySQL and MariaDB", "Port 3306. Open it only to the servers that use the database.", [Tcp(3306)], SuggestSource: true),
            new("postgresql", "PostgreSQL", "Port 5432. Open it only to the servers that use the database.", [Tcp(5432)], SuggestSource: true),
            new("redis", "Redis", "Port 6379. Redis asks for no password unless set up to: open it only to addresses you trust.", [Tcp(6379)], SuggestSource: true),
            new("mongodb", "MongoDB", "Port 27017. Open it only to the servers that use the database.", [Tcp(27017)], SuggestSource: true),
        ];
    }

    private static FirewallRuleSpec Tcp(int port) => new(FirewallAction.Allow, FirewallProtocol.Tcp, port);
}
