using Runova.ServerCore.Contracts;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Platform;

namespace Runova.ServerCore.Firewall;

/// <summary>
/// ufw, the Debian family's firewall. Its whole state is four files: the rules for each family,
/// /etc/default/ufw (IPV6 and the default policies) and /etc/ufw/ufw.conf (whether it is on).
/// Changes go through ufw's own command line, never by editing its rules files, so ufw stays the
/// one that writes them; a snapshot is those four files, and restoring writes them back and has
/// ufw load them again. The core always runs ufw with IPv6 on (IPV6=yes), as ufw ships.
/// </summary>
internal sealed class UfwBackend(IProcessRunner runner, IFirewallCommands commands, ISystemFiles files) : IFirewallBackend
{
    public const string Program = "/usr/sbin/ufw";

    public const string UserRules = "/etc/ufw/user.rules";

    public const string User6Rules = "/etc/ufw/user6.rules";

    public const string Defaults = "/etc/default/ufw";

    public const string Config = "/etc/ufw/ufw.conf";

    /// <summary>0640, as ufw creates its rules files.</summary>
    private const UnixFileMode RulesMode = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead;

    /// <summary>0644, as the package installs its settings.</summary>
    private const UnixFileMode SettingsMode = RulesMode | UnixFileMode.OtherRead;

    public FirewallBackendKind Kind => FirewallBackendKind.Ufw;

    public async Task<FirewallState> ReadAsync(CancellationToken cancellationToken)
    {
        if (!files.Exists(Program))
        {
            return new FirewallState { Backend = FirewallBackendKind.Ufw, Installed = false, Active = false };
        }

        var defaults = OsRelease.Parse(files.ReadText(Defaults) ?? string.Empty);
        var config = OsRelease.Parse(files.ReadText(Config) ?? string.Empty);
        var enabled = IsYes(config.GetValueOrDefault("ENABLED"));
        var ipv6 = IsYes(defaults.GetValueOrDefault("IPV6"));
        var warnings = new List<string>();

        var status = await runner.RunAsync(
            new ProcessSpec { Program = "ufw", Arguments = ["status"], Timeout = TimeSpan.FromSeconds(30) },
            onLine: null,
            cancellationToken);
        bool running;
        if (status.Succeeded)
        {
            running = FirewallSteps.Lines(status.StandardOutput).FirstOrDefault()?.Trim() == "Status: active";
        }
        else
        {
            running = enabled;
            warnings.Add($"The core could not ask ufw whether it is running ({FirstLine(status) ?? $"exit code {status.ExitCode}"}); going by /etc/ufw/ufw.conf.");
        }

        if (enabled && !running)
        {
            warnings.Add("ufw is set to be on (/etc/ufw/ufw.conf) but is not running now. Turning it on from Runova starts it again.");
        }
        else if (!enabled && running)
        {
            warnings.Add("ufw is running, but /etc/ufw/ufw.conf says to leave it off after the next restart.");
        }

        if (!ipv6)
        {
            warnings.Add(
                "ufw is not filtering IPv6 (IPV6 is not yes in /etc/default/ufw), so IPv6 traffic passes untouched. "
                + "The next change from Runova turns IPv6 filtering on.");
        }

        return new FirewallState
        {
            Backend = FirewallBackendKind.Ufw,
            Installed = true,
            Active = running,
            DefaultIncoming = Policy(defaults.GetValueOrDefault("DEFAULT_INPUT_POLICY"), FirewallPolicy.Deny),
            DefaultOutgoing = Policy(defaults.GetValueOrDefault("DEFAULT_OUTPUT_POLICY"), FirewallPolicy.Allow),
            Ipv6 = ipv6,
            Rules = UfwRules.Parse(files.ReadText(UserRules), files.ReadText(User6Rules)),
            Warnings = warnings,
        };
    }

    /// <summary>
    /// IPv6 first (a running ufw reloads to pick it up), then new rules, removals, the default,
    /// and turning ufw on or off last, so the rules are in place before they start to count.
    /// </summary>
    public IReadOnlyList<FirewallStep> Steps(FirewallChangePlan plan)
    {
        ArgumentNullException.ThrowIfNull(plan);
        var steps = new List<FirewallStep>();
        if (!plan.Current.Ipv6)
        {
            steps.Add(new FirewallStep(
                "Turn on IPv6 filtering in /etc/default/ufw (IPV6=yes)",
                Write: new FirewallFileWrite(Defaults, WithIpv6(files.ReadText(Defaults) ?? string.Empty), SettingsMode)));
            if (plan.Current.Active)
            {
                steps.Add(Command(["reload"]));
            }
        }

        foreach (var rule in plan.Added)
        {
            List<string> words = FirewallEvaluation.Blocks(rule) ? ["prepend"] : [];
            words.Add(UfwRules.ActionWord(rule.Action));
            words.AddRange(UfwRules.Spec(rule));
            if (rule.Comment is { } comment)
            {
                words.Add("comment");
                words.Add(comment);
            }

            steps.Add(Command(words));
        }

        foreach (var rule in plan.Removed)
        {
            steps.Add(Command(["--force", "delete", UfwRules.ActionWord(rule.Action), .. UfwRules.Spec(rule)]));
        }

        if (plan.DefaultIncoming is { } policy)
        {
            steps.Add(Command(["default", FirewallEvaluation.Word(policy), "incoming"]));
        }

        if (plan.Enable == true)
        {
            steps.Add(Command(["--force", "enable"]));
        }
        else if (plan.Enable == false)
        {
            steps.Add(Command(["disable"]));
        }

        return steps;
    }

    public Task ApplyAsync(FirewallChangePlan plan, IReadOnlyList<FirewallStep> steps, Action<string> log, CancellationToken cancellationToken) =>
        FirewallSteps.RunAsync(steps, commands, files, log, cancellationToken);

    public Task<FirewallSnapshot> SnapshotAsync(CancellationToken cancellationToken)
    {
        var saved = new List<SnapshotFile>();
        foreach (var (path, mode) in new[] { (UserRules, RulesMode), (User6Rules, RulesMode), (Defaults, SettingsMode), (Config, SettingsMode) })
        {
            var content = files.ReadText(path)
                ?? throw new FirewallRefusedException($"The core cannot read {path}, so it cannot save ufw's rules before the change. Nothing was changed.");
            saved.Add(new SnapshotFile(path, content, mode));
        }

        return Task.FromResult(new FirewallSnapshot(FirewallBackendKind.Ufw, saved, TakenAtUnixMs: 0));
    }

    /// <summary>The four files back as they were, then ufw loads them (reload) or stops (disable).</summary>
    public Task RestoreAsync(FirewallSnapshot snapshot, Action<string> log, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        var steps = snapshot.Files
            .Where(file => file.Content is not null)
            .Select(file => new FirewallStep($"Put back {file.Path}", Write: new FirewallFileWrite(file.Path, file.Content!, file.Mode)))
            .ToList();
        var config = snapshot.Files.FirstOrDefault(file => file.Path == Config)?.Content ?? string.Empty;
        steps.Add(IsYes(OsRelease.Parse(config).GetValueOrDefault("ENABLED")) ? Command(["reload"]) : Command(["disable"]));
        return FirewallSteps.RunAsync(steps, commands, files, log, cancellationToken);
    }

    private static FirewallStep Command(IReadOnlyList<string> arguments) => new(
        "ufw " + string.Join(' ', arguments.Select(Quote)),
        new ProcessSpec { Program = Program, Arguments = [.. arguments], Timeout = TimeSpan.FromMinutes(2) });

    /// <summary>The settings file with IPV6=yes and every other line as it was.</summary>
    private static string WithIpv6(string text)
    {
        var lines = text.Split('\n').ToList();
        var found = false;
        for (var i = 0; i < lines.Count; i++)
        {
            if (lines[i].TrimStart().StartsWith("IPV6=", StringComparison.Ordinal))
            {
                lines[i] = "IPV6=yes";
                found = true;
            }
        }

        var updated = string.Join('\n', lines);
        return found ? updated : updated.TrimEnd('\n') + "\nIPV6=yes\n";
    }

    private static FirewallPolicy Policy(string? value, FirewallPolicy fallback) => value?.Trim().ToUpperInvariant() switch
    {
        "ACCEPT" => FirewallPolicy.Allow,
        "DROP" => FirewallPolicy.Deny,
        "REJECT" => FirewallPolicy.Reject,
        _ => fallback,
    };

    private static bool IsYes(string? value) => value?.Trim().ToUpperInvariant() is "YES" or "TRUE";

    /// <summary>How the command reads in a log: words with spaces are quoted the way a shell would.</summary>
    private static string Quote(string word) =>
        word.Length > 0 && !word.Any(character => char.IsWhiteSpace(character) || character is '\'' or '"' or '\\' or '$' or '`')
            ? word
            : "'" + word.Replace("'", "'\\''", StringComparison.Ordinal) + "'";

    private static string? FirstLine(ProcessResult result) =>
        FirewallSteps.Lines(result.StandardError).Concat(FirewallSteps.Lines(result.StandardOutput)).FirstOrDefault();
}
