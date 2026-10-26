using System.Globalization;
using System.Net;
using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.Firewall;

/// <summary>
/// How this computer reaches the server over SSH, as far as anyone can tell: its addresses as the
/// server sees them, the ports its SSH connection uses, and the ports sshd listens on.
/// </summary>
internal sealed record SshAccess(
    IReadOnlyList<IPAddress> Sources,
    IReadOnlyList<int> Ports,
    IReadOnlyList<int> SshdPorts,
    IPAddress? ServerAddress = null);

/// <summary>
/// Refuses a change set that would stop this computer from opening a new SSH connection: it
/// checks the firewall the change would leave against every address this computer is known by
/// and the port its SSH connection uses (every sshd port when that is unknown). When it cannot
/// tell, it says so and refuses too. A person can still go ahead by typing the phrase it gives.
/// </summary>
internal static class LockoutGuard
{
    public const string UnknownPhrase = "apply without the ssh check";

    public static string PhraseFor(int port) => $"block ssh on port {port.ToString(CultureInfo.InvariantCulture)}";

    public static FirewallGuardVerdict Check(FirewallState result, SshAccess access)
    {
        ArgumentNullException.ThrowIfNull(result);
        ArgumentNullException.ThrowIfNull(access);
        if (!result.Active)
        {
            return new FirewallGuardVerdict(false, [], ["The firewall would be off, so nothing would block SSH."]);
        }

        var sources = access.Sources.Select(FirewallAddresses.Normalize).Distinct().ToList();
        var ports = (access.Ports.Count > 0 ? access.Ports : access.SshdPorts).Where(port => port is > 0 and <= 65535).Distinct().ToList();
        if (sources.Count == 0)
        {
            return Unknown(
                "The core cannot tell which address this computer connects from, so it cannot check that SSH stays open for you. "
                + "Reconnect and try again, or type the phrase to go ahead anyway.");
        }

        if (ports.Count == 0)
        {
            return Unknown(
                "The core cannot tell which port SSH listens on (sshd -T did not say, and neither did this connection), so it cannot "
                + "check that SSH stays open for you.");
        }

        var reasons = new List<string>();
        var checkedProbes = new List<string>();
        int? firstBlocked = null;
        foreach (var source in sources)
        {
            foreach (var port in ports)
            {
                var verdict = FirewallEvaluation.Evaluate(result, new Probe(source, port, FirewallProtocol.Tcp, access.ServerAddress));
                var what = $"SSH from {source} to port {port.ToString(CultureInfo.InvariantCulture)}";
                if (verdict.Allowed)
                {
                    checkedProbes.Add($"{what}: {verdict.Reason}");
                    continue;
                }

                checkedProbes.Add($"{what}: {verdict.Verb}, {verdict.Reason}");
                reasons.Add($"New SSH connections from {source} to port {port.ToString(CultureInfo.InvariantCulture)} would be {verdict.Verb}: {verdict.Reason}.");
                firstBlocked ??= port;
            }
        }

        return firstBlocked is int blockedPort
            ? new FirewallGuardVerdict(true, [.. reasons], [.. checkedProbes], PhraseFor(blockedPort))
            : new FirewallGuardVerdict(false, [], [.. checkedProbes]);
    }

    /// <summary>Whether the typed phrase is the one the verdict asked for (spacing and case aside).</summary>
    public static bool Confirms(FirewallGuardVerdict verdict, string? typed)
    {
        ArgumentNullException.ThrowIfNull(verdict);
        if (!verdict.Blocked)
        {
            return true;
        }

        if (string.IsNullOrWhiteSpace(typed) || typed.Length > 200 || verdict.ConfirmationPhrase is null)
        {
            return false;
        }

        var words = typed.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        return string.Equals(string.Join(' ', words), verdict.ConfirmationPhrase, StringComparison.OrdinalIgnoreCase);
    }

    private static FirewallGuardVerdict Unknown(string reason) => new(true, [reason], [], UnknownPhrase);
}
