using System.Globalization;
using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.Hardening;

/// <summary>An Owner as the checklist needs one.</summary>
internal sealed record OwnerFact(string UserName, bool TwoFactor, bool Disabled, bool Current);

/// <summary>What the checklist judges. A null fact is one the core could not read; its item says so.</summary>
internal sealed record ChecklistFacts
{
    public FirewallStatus? Firewall { get; init; }

    public required SshPolicyInfo Ssh { get; init; }

    public UpdatesInfo? Updates { get; init; }

    public bool? RebootRequired { get; init; }

    public ExposureInventory? Exposure { get; init; }

    public IReadOnlyCollection<int> SshPorts { get; init; } = [];

    public CertificateInfo[]? Certificates { get; init; }

    public IReadOnlyList<OwnerFact>? Owners { get; init; }

    public required string CoreVersion { get; init; }

    public string? AvailableCoreVersion { get; init; }

    public required long NowUnixMs { get; init; }
}

/// <summary>
/// The Security checklist's rules, apart from the gathering so every rule is tested on its own.
/// Weights say how much an item matters (an open door counts three, housekeeping one); the score is
/// the share of the weight of every item the core could judge, a warning earning half.
/// </summary>
internal static class ChecklistRules
{
    /// <summary>A certificate this close to its end with no renewal in sight is worth a look.</summary>
    public static readonly TimeSpan CertificateWarning = TimeSpan.FromDays(14);

    /// <summary>Public ports nobody would call a leak: a website's.</summary>
    private static readonly HashSet<int> _webPorts = [80, 443];

    public static SecurityChecklist Build(ChecklistFacts facts, SshHardeningChangeInfo? pendingSsh = null)
    {
        ArgumentNullException.ThrowIfNull(facts);
        ChecklistItem[] items =
        [
            Firewall(facts.Firewall),
            SshPasswords(facts.Ssh),
            RootLogin(facts.Ssh),
            AutomaticUpdates(facts.Updates),
            Reboot(facts.RebootRequired ?? facts.Updates?.RebootRequired),
            Exposure(facts.Exposure, facts.SshPorts),
            Certificates(facts.Certificates, facts.NowUnixMs),
            CoreVersion(facts.CoreVersion, facts.AvailableCoreVersion),
            OwnersTwoFactor(facts.Owners),
        ];
        return new SecurityChecklist(Score(items), items, facts.Ssh, facts.CoreVersion, facts.NowUnixMs, pendingSsh);
    }

    public static int Score(IEnumerable<ChecklistItem> items)
    {
        ArgumentNullException.ThrowIfNull(items);
        var judged = items.Where(item => item.Status != ChecklistStatus.Unknown).ToList();
        var total = judged.Sum(item => item.Weight);
        if (total == 0)
        {
            return 0;
        }

        var earned = judged.Sum(item => item.Status switch
        {
            ChecklistStatus.Pass => item.Weight * 2,
            ChecklistStatus.Warn => item.Weight,
            _ => 0,
        });
        return (int)Math.Round(100.0 * earned / (total * 2), MidpointRounding.AwayFromZero);
    }

    public static ChecklistItem Firewall(FirewallStatus? status)
    {
        const string title = "Firewall on";
        if (status is null || status.Error is not null)
        {
            return Item("firewall", title, ChecklistStatus.Unknown, 3, status?.Error ?? "The core could not read the firewall.");
        }

        if (!status.Installed || status.Backend == FirewallBackendKind.None)
        {
            return Item("firewall", title, ChecklistStatus.Fail, 3, "Neither ufw nor firewalld is installed, so every listening port is open.");
        }

        return status.Active
            ? Item("firewall", title, ChecklistStatus.Pass, 3, $"{Name(status.Backend)} is on.")
            : Item("firewall", title, ChecklistStatus.Fail, 3, $"{Name(status.Backend)} is off, so every listening port is open.", ChecklistFix.EnableFirewall);
    }

    public static ChecklistItem SshPasswords(SshPolicyInfo ssh)
    {
        ArgumentNullException.ThrowIfNull(ssh);
        const string title = "SSH password login off";
        if (ssh.Error is not null)
        {
            return Item("ssh-passwords", title, ChecklistStatus.Unknown, 3, ssh.Error);
        }

        return SshdPolicy.PasswordsOpen(ssh)
            ? Item("ssh-passwords", title, ChecklistStatus.Fail, 3, "sshd accepts passwords, which anyone can try to guess. Keys cannot be guessed.", ChecklistFix.DisableSshPasswordLogin)
            : Item("ssh-passwords", title, ChecklistStatus.Pass, 3, "sshd only lets keys in.");
    }

    public static ChecklistItem RootLogin(SshPolicyInfo ssh)
    {
        ArgumentNullException.ThrowIfNull(ssh);
        const string title = "Root signs in with a key only";
        if (ssh.Error is not null || ssh.RootLogin is null)
        {
            return Item("ssh-root", title, ChecklistStatus.Unknown, 2, ssh.Error ?? "sshd did not say whether root may sign in.");
        }

        return SshdPolicy.RootRestricted(ssh)
            ? Item("ssh-root", title, ChecklistStatus.Pass, 2, $"PermitRootLogin is {ssh.RootLogin}.")
            : Item("ssh-root", title, ChecklistStatus.Warn, 2, "Root may sign in with a password.", ChecklistFix.RestrictRootLogin);
    }

    public static ChecklistItem AutomaticUpdates(UpdatesInfo? updates)
    {
        const string title = "Automatic security updates";
        var automatic = updates?.AutomaticSecurityUpdates;
        if (automatic is null || !automatic.Supported)
        {
            return Item("auto-updates", title, ChecklistStatus.Unknown, 2, "This server's package manager has no automatic updates the core knows.");
        }

        return automatic.Enabled
            ? Item("auto-updates", title, ChecklistStatus.Pass, 2, $"{automatic.Mechanism} installs security updates by itself.")
            : Item("auto-updates", title, ChecklistStatus.Fail, 2, $"Security fixes wait until someone installs them. {automatic.Mechanism} can do it every day.", ChecklistFix.EnableAutomaticUpdates);
    }

    public static ChecklistItem Reboot(bool? required)
    {
        const string title = "No reboot waiting";
        return required switch
        {
            null => Item("reboot", title, ChecklistStatus.Unknown, 1, "The core could not tell whether a reboot is waiting."),
            true => Item("reboot", title, ChecklistStatus.Warn, 1, "Updates are installed that only take effect after a reboot.", ChecklistFix.Reboot),
            false => Item("reboot", title, ChecklistStatus.Pass, 1, "Everything installed is running."),
        };
    }

    public static ChecklistItem Exposure(ExposureInventory? exposure, IReadOnlyCollection<int> sshPorts)
    {
        ArgumentNullException.ThrowIfNull(sshPorts);
        const string title = "No unexpected public ports";
        if (exposure is null || exposure.SocketsError is not null)
        {
            return Item("exposure", title, ChecklistStatus.Unknown, 2, exposure?.SocketsError ?? "The core could not list what listens.");
        }

        var expected = new HashSet<int>(sshPorts.Count > 0 ? sshPorts : [22]);
        expected.UnionWith(_webPorts);
        var sockets = exposure.Sockets
            .Where(socket => socket.Scope == ExposureScope.Public
                && socket.Firewall is ExposureFirewall.Off or ExposureFirewall.Open or ExposureFirewall.Bypassed
                && !expected.Contains(socket.Port))
            .Select(socket => $"{socket.Port.ToString(CultureInfo.InvariantCulture)}/{Protocol(socket.Protocol)}")
            .Distinct(StringComparer.Ordinal)
            .ToList();
        var containers = exposure.Containers
            .Where(port => port.Scope == ExposureScope.Public && !_webPorts.Contains(port.HostPort))
            .Select(port => $"{port.HostPort.ToString(CultureInfo.InvariantCulture)}/{Protocol(port.Protocol)} ({port.ContainerName})")
            .Distinct(StringComparer.Ordinal)
            .ToList();
        if (sockets.Count == 0 && containers.Count == 0)
        {
            return Item("exposure", title, ChecklistStatus.Pass, 2, "Only SSH and web ports are reachable from anywhere.");
        }

        var parts = new List<string>();
        if (containers.Count > 0)
        {
            parts.Add($"Docker publishes {string.Join(", ", containers)} past the firewall.");
        }

        if (sockets.Count > 0)
        {
            parts.Add($"Reachable from anywhere: {string.Join(", ", sockets)}.");
        }

        return Item(
            "exposure",
            title,
            containers.Count > 0 ? ChecklistStatus.Fail : ChecklistStatus.Warn,
            2,
            string.Join(" ", parts),
            ChecklistFix.ReviewExposure,
            [.. containers, .. sockets]);
    }

    public static ChecklistItem Certificates(CertificateInfo[]? certificates, long nowUnixMs)
    {
        const string title = "Certificates healthy";
        if (certificates is null)
        {
            return Item("certificates", title, ChecklistStatus.Unknown, 2, "The core could not read its certificates.");
        }

        var live = certificates.Where(certificate => certificate.State is not CertificateState.Revoked).ToList();
        if (live.Count == 0)
        {
            return Item("certificates", title, ChecklistStatus.Pass, 2, "No site has a certificate yet.");
        }

        var soon = nowUnixMs + (long)CertificateWarning.TotalMilliseconds;
        var expired = live.Where(certificate => certificate.NotAfterUnixMs <= nowUnixMs).ToList();
        var failing = live.Where(certificate => certificate.FailedAttempts > 0 && certificate.NotAfterUnixMs > nowUnixMs).ToList();
        var expiring = live.Where(certificate => certificate.NotAfterUnixMs > nowUnixMs && certificate.NotAfterUnixMs <= soon && certificate.FailedAttempts == 0).ToList();
        var renewable = expired.Concat(failing).Concat(expiring)
            .Where(certificate => certificate.Source == CertificateSource.Acme)
            .Select(certificate => certificate.SiteId)
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        if (expired.Count > 0 || failing.Count > 0)
        {
            var parts = new List<string>();
            if (expired.Count > 0)
            {
                parts.Add($"Expired: {Domains(expired)}.");
            }

            if (failing.Count > 0)
            {
                parts.Add($"Renewal keeps failing: {Domains(failing)}.");
            }

            return Item("certificates", title, ChecklistStatus.Fail, 2, string.Join(" ", parts), Fix(renewable), renewable);
        }

        if (expiring.Count > 0)
        {
            return Item("certificates", title, ChecklistStatus.Warn, 2, $"Ends within {CertificateWarning.TotalDays.ToString(CultureInfo.InvariantCulture)} days: {Domains(expiring)}.", Fix(renewable), renewable);
        }

        return Item("certificates", title, ChecklistStatus.Pass, 2, $"{live.Count.ToString(CultureInfo.InvariantCulture)} certificate{(live.Count == 1 ? string.Empty : "s")}, none close to ending.");
    }

    public static ChecklistItem CoreVersion(string current, string? available)
    {
        ArgumentNullException.ThrowIfNull(current);
        const string title = "Server core up to date";
        if (string.IsNullOrWhiteSpace(available))
        {
            return Item("core-version", title, ChecklistStatus.Unknown, 1, $"Runs {current}. This copy of Runova has no release to compare it with.");
        }

        return Compare(current, available) >= 0
            ? Item("core-version", title, ChecklistStatus.Pass, 1, $"Runs {current}, the release this app installs.")
            : Item("core-version", title, ChecklistStatus.Warn, 1, $"Runs {current}; {available} is available.", ChecklistFix.UpdateCore, [available]);
    }

    public static ChecklistItem OwnersTwoFactor(IReadOnlyList<OwnerFact>? owners)
    {
        const string title = "Two-factor for every Owner";
        if (owners is null)
        {
            return Item("owners-2fa", title, ChecklistStatus.Unknown, 2, "The core could not read its users.");
        }

        var without = owners.Where(owner => !owner.Disabled && !owner.TwoFactor).ToList();
        if (without.Count == 0)
        {
            return Item("owners-2fa", title, ChecklistStatus.Pass, 2, "Every Owner signs in with a code from an authenticator app as well.");
        }

        var names = without.Select(owner => owner.UserName).Order(StringComparer.Ordinal).ToArray();
        var fix = without.Any(owner => owner.Current) ? ChecklistFix.EnableTwoFactor : ChecklistFix.None;
        return Item("owners-2fa", title, ChecklistStatus.Fail, 2, $"Without two-factor: {string.Join(", ", names)}. A stolen password is then enough to take the server.", fix, names);
    }

    /// <summary>
    /// Release versions, numbers first ("1.4.0" before "1.10.0"); a pre-release ("-dev", "-rc.1")
    /// comes before the release itself. Anything unreadable counts as older, so the app offers the update.
    /// </summary>
    public static int Compare(string current, string available)
    {
        ArgumentNullException.ThrowIfNull(current);
        ArgumentNullException.ThrowIfNull(available);
        if (string.Equals(current, available, StringComparison.Ordinal))
        {
            return 0;
        }

        if (!TryParts(current, out var mine, out var minePre) || !TryParts(available, out var theirs, out var theirsPre))
        {
            return -1;
        }

        for (var index = 0; index < Math.Max(mine.Length, theirs.Length); index++)
        {
            var difference = (index < mine.Length ? mine[index] : 0).CompareTo(index < theirs.Length ? theirs[index] : 0);
            if (difference != 0)
            {
                return difference;
            }
        }

        return (minePre, theirsPre) switch
        {
            (null, null) => 0,
            (null, _) => 1,
            (_, null) => -1,
            _ => string.CompareOrdinal(minePre, theirsPre),
        };
    }

    private static bool TryParts(string version, out int[] numbers, out string? preRelease)
    {
        var plain = version.Split('+')[0];
        var dash = plain.IndexOf('-', StringComparison.Ordinal);
        preRelease = dash < 0 ? null : plain[(dash + 1)..];
        var core = dash < 0 ? plain : plain[..dash];
        var parsed = new List<int>();
        foreach (var part in core.Split('.'))
        {
            if (!int.TryParse(part, NumberStyles.None, CultureInfo.InvariantCulture, out var number))
            {
                numbers = [];
                return false;
            }

            parsed.Add(number);
        }

        numbers = [.. parsed];
        return numbers.Length > 0;
    }

    private static ChecklistFix Fix(string[] renewable) => renewable.Length > 0 ? ChecklistFix.RenewCertificates : ChecklistFix.None;

    private static string Domains(IEnumerable<CertificateInfo> certificates) =>
        string.Join(", ", certificates.Select(certificate => certificate.Domains.FirstOrDefault() ?? certificate.SiteId));

    private static string Name(FirewallBackendKind backend) => backend == FirewallBackendKind.Firewalld ? "firewalld" : "ufw";

    private static string Protocol(FirewallProtocol protocol) => protocol == FirewallProtocol.Udp ? "udp" : "tcp";

    private static ChecklistItem Item(string id, string title, ChecklistStatus status, int weight, string detail, ChecklistFix fix = ChecklistFix.None, string[]? targets = null) =>
        new(id, title, status, weight, detail, fix, targets ?? []);
}
