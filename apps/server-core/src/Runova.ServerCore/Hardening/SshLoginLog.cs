using System.Globalization;
using System.Net;
using System.Text.Json;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Firewall;

namespace Runova.ServerCore.Hardening;

/// <summary>One sign-in as sshd logged it: "Accepted publickey for root from 203.0.113.50 port 51234 ssh2".</summary>
internal sealed record SshLogin(string Method, string UserName, IPAddress Client, int ClientPort, long? AtUnixMs);

internal static class SshLoginLines
{
    private const string Accepted = "Accepted ";

    public const string KeyMethod = "publickey";

    public static SshLogin? Parse(string? line, long? atUnixMs)
    {
        if (string.IsNullOrEmpty(line))
        {
            return null;
        }

        var start = line.IndexOf(Accepted, StringComparison.Ordinal);
        if (start < 0)
        {
            return null;
        }

        // Accepted <method> for <user> from <address> port <port> ...
        var words = line[(start + Accepted.Length)..].Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (words.Length < 7 || words[1] != "for" || words[3] != "from" || words[5] != "port"
            || !FirewallAddresses.TryParseAddress(words[4], out var client)
            || !int.TryParse(words[6], NumberStyles.None, CultureInfo.InvariantCulture, out var port)
            || port is < 1 or > 65535)
        {
            return null;
        }

        return new SshLogin(words[0], words[2], FirewallAddresses.Normalize(client), port, atUnixMs);
    }

    /// <summary>The last sign-in logged for this connection (its client address and port).</summary>
    public static SshLogin? Latest(IEnumerable<SshLogin> logins, SshEndpoint connection)
    {
        ArgumentNullException.ThrowIfNull(logins);
        ArgumentNullException.ThrowIfNull(connection);
        var client = FirewallAddresses.Normalize(connection.Client);
        return logins.LastOrDefault(login => login.ClientPort == connection.ClientPort && login.Client.Equals(client));
    }

    /// <summary>Whether this connection is proven to have signed in with a key, in words for the app.</summary>
    public static SshLoginProof Judge(SshEndpoint? connection, SshLogin? login)
    {
        if (connection is null)
        {
            return new SshLoginProof(
                false,
                "The core could not tell which SSH connection this came over, so it cannot check how it signed in.");
        }

        var where = $"{connection.Client} port {connection.ClientPort.ToString(CultureInfo.InvariantCulture)}";
        if (login is null)
        {
            return new SshLoginProof(
                false,
                $"sshd's log has no recent sign-in for this connection ({where}), so the core cannot prove it used a key.");
        }

        if (login.Method != KeyMethod)
        {
            return new SshLoginProof(
                false,
                $"This connection signed in as {login.UserName} with \"{login.Method}\", not a key. Switch the saved server to key login first, so that turning off passwords cannot lock the app out.",
                login.Method,
                login.UserName,
                login.AtUnixMs);
        }

        return new SshLoginProof(
            true,
            $"This connection ({where}) signed in as {login.UserName} with a key.",
            login.Method,
            login.UserName,
            login.AtUnixMs);
    }
}

/// <summary>Finds how one SSH connection signed in.</summary>
internal interface ISshLoginLog
{
    Task<SshLogin?> FindAsync(SshEndpoint connection, CancellationToken cancellationToken);
}

/// <summary>
/// sshd's sign-ins from the journal (sshd before OpenSSH 9.8, sshd-session after), over the last
/// half hour: the app proves a key login with a connection it has just opened. Where there is no
/// journal, the syslog files (auth.log on the Debian family, secure on the RHEL family).
/// </summary>
internal sealed class JournalSshLoginLog(IProcessRunner runner) : ISshLoginLog
{
    public static readonly TimeSpan Window = TimeSpan.FromMinutes(30);

    private const int MaxJournalBytes = 8 * 1024 * 1024;
    private const int MaxFileTailBytes = 2 * 1024 * 1024;

    private static readonly string[] _syslogFiles = ["/var/log/auth.log", "/var/log/secure"];

    public async Task<SshLogin?> FindAsync(SshEndpoint connection, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(connection);
        var logins = await FromJournalAsync(cancellationToken);
        var found = SshLoginLines.Latest(logins, connection);
        return found ?? SshLoginLines.Latest(FromFiles(), connection);
    }

    /// <summary>`journalctl -o json`: one object per line, MESSAGE and __REALTIME_TIMESTAMP (microseconds).</summary>
    public static IReadOnlyList<SshLogin> ParseJournal(string output)
    {
        ArgumentNullException.ThrowIfNull(output);
        var logins = new List<SshLogin>();
        foreach (var line in output.Split('\n'))
        {
            if (!line.Contains("Accepted ", StringComparison.Ordinal))
            {
                continue;
            }

            try
            {
                using var entry = JsonDocument.Parse(line);
                var root = entry.RootElement;
                if (!root.TryGetProperty("MESSAGE", out var message) || message.ValueKind != JsonValueKind.String)
                {
                    continue;
                }

                long? at = root.TryGetProperty("__REALTIME_TIMESTAMP", out var stamp)
                    && long.TryParse(stamp.GetString(), NumberStyles.None, CultureInfo.InvariantCulture, out var micros)
                    ? micros / 1000
                    : null;
                if (SshLoginLines.Parse(message.GetString(), at) is { } login)
                {
                    logins.Add(login);
                }
            }
            catch (JsonException)
            {
                // A line cut short by the output cap.
            }
        }

        return logins;
    }

    private async Task<IReadOnlyList<SshLogin>> FromJournalAsync(CancellationToken cancellationToken)
    {
        try
        {
            var since = $"--since=-{((int)Window.TotalMinutes).ToString(CultureInfo.InvariantCulture)}min";
            var result = await runner.RunAsync(
                new ProcessSpec
                {
                    Program = "journalctl",
                    Arguments = ["--no-pager", "-o", "json", since, "-t", "sshd", "-t", "sshd-session", "-t", "sshd-auth"],
                    Timeout = TimeSpan.FromSeconds(20),
                    MaxOutputBytes = MaxJournalBytes,
                },
                onLine: null,
                cancellationToken);
            return result.Succeeded || result.OutputTruncated ? ParseJournal(result.StandardOutput) : [];
        }
        catch (ProcessStartException)
        {
            return [];
        }
    }

    private static List<SshLogin> FromFiles()
    {
        var logins = new List<SshLogin>();
        foreach (var path in _syslogFiles)
        {
            foreach (var line in Tail(path).Split('\n'))
            {
                if (SshLoginLines.Parse(line, null) is { } login)
                {
                    logins.Add(login);
                }
            }
        }

        return logins;
    }

    private static string Tail(string path)
    {
        try
        {
            using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            var start = Math.Max(0, file.Length - MaxFileTailBytes);
            file.Seek(start, SeekOrigin.Begin);
            using var reader = new StreamReader(file);
            return reader.ReadToEnd();
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            return string.Empty;
        }
    }
}
