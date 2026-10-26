using System.Text;
using Runova.ServerCore.Compatibility;
using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.Hardening;

/// <summary>The settings Runova's drop-in holds. Once one is on, a later change keeps it.</summary>
internal sealed record ManagedSshSettings(bool DisablePasswordLogin, bool RestrictRootLogin)
{
    public bool Any => DisablePasswordLogin || RestrictRootLogin;
}

/// <summary>
/// Reads sshd's effective settings and writes the one file Runova owns,
/// /etc/ssh/sshd_config.d/00-runova.conf. sshd takes the first value it reads for a keyword, and
/// every supported distribution includes that folder at the top of sshd_config, so a name that
/// sorts first wins over the distribution's own files (50-cloud-init.conf, 50-redhat.conf). The core
/// still checks with `sshd -T` after writing it, rather than trusting that.
/// </summary>
internal static class SshdPolicy
{
    public const string RunovaDropInPath = "/etc/ssh/sshd_config.d/00-runova.conf";

    /// <summary>
    /// The one file the core owns: the drop-in a server got before the rename keeps its name (and
    /// so its place in sshd's reading order), a new one gets the new name.
    /// </summary>
    public static string DropInPath => File.Exists(LegacyNames.SshdDropInPath) && !File.Exists(RunovaDropInPath)
        ? LegacyNames.SshdDropInPath
        : RunovaDropInPath;

    private const string Header =
        "# Written by Runova's security checklist. Delete this file and reload sshd to undo it.\n";

    public static SshPolicyInfo Parse(string sshdT, bool managed)
    {
        ArgumentNullException.ThrowIfNull(sshdT);
        var values = Values(sshdT);
        return new SshPolicyInfo(
            Flag(values, "passwordauthentication"),
            Flag(values, "kbdinteractiveauthentication") ?? Flag(values, "challengeresponseauthentication"),
            Flag(values, "pubkeyauthentication"),
            values.GetValueOrDefault("permitrootlogin"),
            managed);
    }

    /// <summary>Whether a password still gets in, typed directly or through keyboard-interactive (PAM).</summary>
    public static bool PasswordsOpen(SshPolicyInfo policy)
    {
        ArgumentNullException.ThrowIfNull(policy);
        return policy.PasswordLogin != false || policy.KeyboardInteractiveLogin != false;
    }

    /// <summary>Whether root can only come in with a key (or not at all).</summary>
    public static bool RootRestricted(SshPolicyInfo policy)
    {
        ArgumentNullException.ThrowIfNull(policy);
        return policy.RootLogin is "no" or "prohibit-password" or "without-password" or "forced-commands-only";
    }

    /// <summary>What the drop-in should hold: what it holds now plus what is asked for.</summary>
    public static ManagedSshSettings Merge(string? current, SshHardeningRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        var held = ReadManaged(current);
        return new ManagedSshSettings(
            held.DisablePasswordLogin || request.DisablePasswordLogin,
            held.RestrictRootLogin || request.RestrictRootLogin);
    }

    public static ManagedSshSettings ReadManaged(string? content)
    {
        if (string.IsNullOrEmpty(content))
        {
            return new ManagedSshSettings(false, false);
        }

        var values = Values(content);
        return new ManagedSshSettings(
            values.GetValueOrDefault("passwordauthentication") == "no",
            values.GetValueOrDefault("permitrootlogin") == "prohibit-password");
    }

    public static string Render(ManagedSshSettings settings)
    {
        ArgumentNullException.ThrowIfNull(settings);
        var text = new StringBuilder(Header);
        if (settings.DisablePasswordLogin)
        {
            // Both: with PAM, keyboard-interactive asks for the same password.
            text.Append("PasswordAuthentication no\n");
            text.Append("KbdInteractiveAuthentication no\n");
        }

        if (settings.RestrictRootLogin)
        {
            text.Append("PermitRootLogin prohibit-password\n");
        }

        return text.ToString();
    }

    /// <summary>Whether sshd now runs with everything the drop-in asks for.</summary>
    public static bool Holds(SshPolicyInfo effective, ManagedSshSettings wanted)
    {
        ArgumentNullException.ThrowIfNull(effective);
        ArgumentNullException.ThrowIfNull(wanted);
        return (!wanted.DisablePasswordLogin || !PasswordsOpen(effective))
            && (!wanted.RestrictRootLogin || RootRestricted(effective));
    }

    public static string Describe(ManagedSshSettings settings)
    {
        ArgumentNullException.ThrowIfNull(settings);
        return (settings.DisablePasswordLogin, settings.RestrictRootLogin) switch
        {
            (true, true) => "SSH password login off; root signs in with a key only",
            (true, false) => "SSH password login off",
            (false, true) => "Root signs in over SSH with a key only",
            _ => "No SSH change",
        };
    }

    /// <summary>The first value of each keyword, lowercased: sshd's own rule, and sshd -T prints one anyway.</summary>
    private static Dictionary<string, string> Values(string text)
    {
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var raw in text.Split('\n'))
        {
            var line = raw.Trim();
            if (line.Length == 0 || line[0] == '#')
            {
                continue;
            }

            var space = line.IndexOfAny([' ', '\t']);
            if (space <= 0)
            {
                continue;
            }

            var key = line[..space].ToLowerInvariant();
            values.TryAdd(key, line[(space + 1)..].Trim().ToLowerInvariant());
        }

        return values;
    }

    private static bool? Flag(Dictionary<string, string> values, string key) =>
        values.GetValueOrDefault(key) switch
        {
            "yes" => true,
            "no" => false,
            _ => null,
        };
}
