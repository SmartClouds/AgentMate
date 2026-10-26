using System.Text.RegularExpressions;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Platform;

namespace Runova.ServerCore.Firewall;

/// <summary>
/// firewalld, the RHEL family's firewall. The core manages the default zone through its
/// permanent settings and a reload, so what it sets survives a restart and runtime and saved rules
/// never drift apart; while firewalld runs rules that were never saved, it changes nothing (a
/// reload would drop them). A stopped firewalld is changed with firewall-offline-cmd. A snapshot
/// is the zone's file, firewalld.conf, and whether the service ran and started at boot.
/// </summary>
internal sealed partial class FirewalldBackend(IProcessRunner runner, IFirewallCommands commands, ISystemFiles files) : IFirewallBackend
{
    public const string Program = "/usr/bin/firewall-cmd";

    public const string OfflineProgram = "/usr/bin/firewall-offline-cmd";

    public const string Systemctl = "/usr/bin/systemctl";

    public const string Config = "/etc/firewalld/firewalld.conf";

    /// <summary>Zones the administrator (or firewalld, once changed) keeps.</summary>
    public const string ZoneFolder = "/etc/firewalld/zones";

    /// <summary>Zones as the package ships them; used while /etc has no copy.</summary>
    public const string DefaultZoneFolder = "/usr/lib/firewalld/zones";

    private const string Unit = "firewalld.service";

    /// <summary>0644, as firewalld writes its zone files.</summary>
    private const UnixFileMode ZoneMode = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead | UnixFileMode.OtherRead;

    /// <summary>0640, as the package installs firewalld.conf.</summary>
    private const UnixFileMode ConfigMode = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead;

    public FirewallBackendKind Kind => FirewallBackendKind.Firewalld;

    public async Task<FirewallState> ReadAsync(CancellationToken cancellationToken)
    {
        if (!files.Exists(Program))
        {
            return new FirewallState { Backend = FirewallBackendKind.Firewalld, Installed = false, Active = false };
        }

        var running = await IsRunningAsync(cancellationToken);
        var tool = running ? "firewall-cmd" : "firewall-offline-cmd";
        var zone = await ZoneAsync(tool, cancellationToken);
        var saved = FirewalldListing.ParseZone(await ReadOrThrowAsync(
            tool,
            running ? ["--permanent", $"--zone={zone}", "--list-all"] : [$"--zone={zone}", "--list-all"],
            cancellationToken));

        var warnings = new List<string>();
        string? refusal = null;
        if (running)
        {
            var live = FirewalldListing.ParseZone(await ReadOrThrowAsync(tool, [$"--zone={zone}", "--list-all"], cancellationToken));
            if (live.Comparable() != saved.Comparable())
            {
                warnings.Add($"firewalld is running rules in the {zone} zone that are not saved to its permanent settings.");
                refusal =
                    $"firewalld is running rules in the {zone} zone that are not saved, and the core's changes reload firewalld, which "
                    + "would drop them. Save them first with firewall-cmd --runtime-to-permanent (or drop them with firewall-cmd "
                    + "--reload), then try again.";
            }

            warnings.AddRange(await OtherZonesAsync(zone, cancellationToken));
        }

        var services = new Dictionary<string, IReadOnlyList<FirewallRule>>(StringComparer.Ordinal);
        foreach (var name in saved.Words("services").Concat(saved.RichRules.SelectMany(ServiceNames)).Distinct(StringComparer.Ordinal))
        {
            services[name] = FirewalldListing.Service(name, ServiceName().IsMatch(name) ? await InfoAsync(tool, name, cancellationToken) : null);
        }

        var rules = new List<FirewallRule>();
        foreach (var name in saved.Words("services"))
        {
            rules.AddRange(services[name]);
        }

        foreach (var word in saved.Words("ports"))
        {
            rules.Add(FirewalldListing.PortWord(word) is { } port
                ? new FirewallRule
                {
                    Action = FirewallAction.Allow,
                    Shape = "port",
                    Protocol = port.Protocol,
                    Ports = port.Ports,
                    Native = word,
                    Families = FirewallFamilies.Both,
                }
                : new FirewallRule
                {
                    Action = FirewallAction.Allow,
                    Shape = "port",
                    Protocol = FirewallProtocol.Any,
                    Native = word,
                    Families = FirewallFamilies.Both,
                    Unknown = $"it opens {word}, a protocol Runova does not manage",
                    ReadOnlyReason = "it uses a protocol Runova does not manage",
                });
        }

        foreach (var word in saved.Words("protocols"))
        {
            rules.Add(new FirewallRule
            {
                Action = FirewallAction.Allow,
                Shape = "protocol",
                Protocol = FirewallProtocol.Any,
                Native = word,
                Families = FirewallFamilies.Both,
                Unknown = $"it lets in every packet of the protocol {word}",
                ReadOnlyReason = "Runova does not manage protocol rules",
            });
        }

        foreach (var text in saved.RichRules)
        {
            if (FirewalldListing.RichRule(text, name => services.TryGetValue(name, out var opened) && opened is [{ Ports: { } ports, Unknown: null } single]
                ? (ports, single.Protocol)
                : null) is { } rule)
            {
                rules.Add(rule);
            }
        }

        if (saved.Words("source-ports").Count > 0)
        {
            warnings.Add($"The {zone} zone also lets in traffic by source port ({saved.Value("source-ports")}), which Runova does not manage.");
        }

        return new FirewallState
        {
            Backend = FirewallBackendKind.Firewalld,
            Installed = true,
            Active = running,
            DefaultIncoming = Target(saved.Value("target")),
            DefaultOutgoing = FirewallPolicy.Allow,
            Ipv6 = true,
            Zone = zone,
            Rules = rules,
            Warnings = warnings,
            RefusalReason = refusal,
        };
    }

    /// <summary>Rule changes and the target in the permanent settings, then a reload; turning firewalld on or off last.</summary>
    public IReadOnlyList<FirewallStep> Steps(FirewallChangePlan plan)
    {
        ArgumentNullException.ThrowIfNull(plan);
        var zone = plan.Current.Zone ?? throw new FirewallRefusedException("The core could not tell which firewalld zone to change.");
        var running = plan.Current.Active;
        var steps = new List<FirewallStep>();

        void Zone(string argument) => steps.Add(running
            ? Command(Program, ["--permanent", $"--zone={zone}", argument])
            : Command(OfflineProgram, [$"--zone={zone}", argument]));

        foreach (var rule in plan.Added)
        {
            Zone(rule.Shape == "port" ? $"--add-port={rule.Ports}/{Protocol(rule)}" : $"--add-rich-rule={FirewalldListing.RichText(rule)}");
        }

        foreach (var rule in plan.Removed)
        {
            Zone(rule.Shape switch
            {
                "port" => $"--remove-port={rule.Native}",
                "service" => $"--remove-service={rule.Native}",
                "rich" => $"--remove-rich-rule={rule.Native}",
                _ => throw new FirewallRefusedException($"\"{FirewallEvaluation.Describe(rule)}\" cannot be removed from Runova."),
            });
        }

        if (plan.DefaultIncoming is { } policy)
        {
            Zone(policy switch
            {
                FirewallPolicy.Allow => "--set-target=ACCEPT",
                FirewallPolicy.Deny => "--set-target=DROP",
                _ => "--set-target=default",
            });
        }

        if (running && steps.Count > 0)
        {
            steps.Add(Command(Program, ["--reload"]));
        }

        if (plan.Enable == true && !running)
        {
            steps.Add(Command(Systemctl, ["enable", "--now", Unit]));
        }
        else if (plan.Enable == false && running)
        {
            steps.Add(Command(Systemctl, ["disable", "--now", Unit]));
        }

        return steps;
    }

    public Task ApplyAsync(FirewallChangePlan plan, IReadOnlyList<FirewallStep> steps, Action<string> log, CancellationToken cancellationToken) =>
        FirewallSteps.RunAsync(steps, commands, files, log, cancellationToken);

    public async Task<FirewallSnapshot> SnapshotAsync(CancellationToken cancellationToken)
    {
        var running = await IsRunningAsync(cancellationToken);
        var zone = await ZoneAsync(running ? "firewall-cmd" : "firewall-offline-cmd", cancellationToken);
        var zoneFile = $"{ZoneFolder}/{zone}.xml";
        var content = files.ReadText(zoneFile) ?? files.ReadText($"{DefaultZoneFolder}/{zone}.xml")
            ?? throw new FirewallRefusedException(
                $"The core cannot read the {zone} zone's file, so it cannot save firewalld's rules before the change. Nothing was changed.");
        var config = files.ReadText(Config)
            ?? throw new FirewallRefusedException($"The core cannot read {Config}, so it cannot save firewalld's settings. Nothing was changed.");

        var show = await runner.RunAsync(
            new ProcessSpec { Program = "systemctl", Arguments = ["show", "--property=ActiveState,UnitFileState", Unit], Timeout = TimeSpan.FromSeconds(15) },
            onLine: null,
            cancellationToken);
        var properties = OsRelease.Parse(show.StandardOutput);
        return new FirewallSnapshot(
            FirewallBackendKind.Firewalld,
            [new SnapshotFile(zoneFile, content, ZoneMode), new SnapshotFile(Config, config, ConfigMode)],
            TakenAtUnixMs: 0,
            ServiceActive: properties.GetValueOrDefault("ActiveState") is "active" or "activating" || running,
            ServiceEnabled: properties.GetValueOrDefault("UnitFileState") is "enabled" or "enabled-runtime",
            Zone: zone);
    }

    /// <summary>The files back as they were, then firewalld loads them (or stops), and starts at boot as it did.</summary>
    public async Task RestoreAsync(FirewallSnapshot snapshot, Action<string> log, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        var steps = snapshot.Files
            .Where(file => file.Content is not null)
            .Select(file => new FirewallStep($"Put back {file.Path}", Write: new FirewallFileWrite(file.Path, file.Content!, file.Mode)))
            .ToList();
        var running = await IsRunningAsync(cancellationToken);
        if (snapshot.ServiceActive != false)
        {
            steps.Add(running ? Command(Program, ["--reload"]) : Command(Systemctl, ["start", Unit]));
        }
        else if (running)
        {
            steps.Add(Command(Systemctl, ["stop", Unit]));
        }

        if (snapshot.ServiceEnabled is { } enabled)
        {
            steps.Add(Command(Systemctl, [enabled ? "enable" : "disable", Unit]));
        }

        await FirewallSteps.RunAsync(steps, commands, files, log, cancellationToken);
    }

    private async Task<bool> IsRunningAsync(CancellationToken cancellationToken)
    {
        var state = await runner.RunAsync(
            new ProcessSpec { Program = "firewall-cmd", Arguments = ["--state"], Timeout = TimeSpan.FromSeconds(30) },
            onLine: null,
            cancellationToken);
        return state.Succeeded && state.StandardOutput.Trim() == "running";
    }

    private async Task<string> ZoneAsync(string tool, CancellationToken cancellationToken)
    {
        var zone = (await ReadOrThrowAsync(tool, ["--get-default-zone"], cancellationToken)).Trim();
        // The zone name becomes part of a file path, so it is checked like one.
        return ZoneName().IsMatch(zone)
            ? zone
            : throw new FirewallRefusedException($"firewalld's default zone has a name the core does not accept ('{zone}').");
    }

    /// <summary>Zones other than the managed one that bind interfaces or sources: their rules apply there instead.</summary>
    private async Task<IEnumerable<string>> OtherZonesAsync(string zone, CancellationToken cancellationToken)
    {
        var result = await runner.RunAsync(
            new ProcessSpec { Program = "firewall-cmd", Arguments = ["--get-active-zones"], Timeout = TimeSpan.FromSeconds(30) },
            onLine: null,
            cancellationToken);
        if (!result.Succeeded)
        {
            return [];
        }

        var others = new List<string>();
        string? current = null;
        var bindings = new List<string>();
        void Flush()
        {
            if (current is not null && current != zone && bindings.Count > 0)
            {
                others.Add($"The {current} zone is active too ({string.Join("; ", bindings)}). Traffic it takes in follows its own rules, not the {zone} zone's.");
            }

            bindings.Clear();
        }

        foreach (var line in result.StandardOutput.Split('\n'))
        {
            if (line.Length > 0 && !char.IsWhiteSpace(line[0]))
            {
                Flush();
                current = line.Trim();
            }
            else if (line.Trim() is { Length: > 0 } binding)
            {
                bindings.Add(binding);
            }
        }

        Flush();
        return others;
    }

    private async Task<string?> InfoAsync(string tool, string service, CancellationToken cancellationToken)
    {
        var result = await runner.RunAsync(
            new ProcessSpec { Program = tool, Arguments = [$"--info-service={service}"], Timeout = TimeSpan.FromSeconds(30) },
            onLine: null,
            cancellationToken);
        return result.Succeeded ? result.StandardOutput : null;
    }

    private async Task<string> ReadOrThrowAsync(string tool, string[] arguments, CancellationToken cancellationToken)
    {
        var result = await runner.RunAsync(
            new ProcessSpec { Program = tool, Arguments = arguments, Timeout = TimeSpan.FromSeconds(30), MaxOutputBytes = 4 * 1024 * 1024 },
            onLine: null,
            cancellationToken);
        if (!result.Succeeded)
        {
            var said = FirewallSteps.Lines(result.StandardError).Concat(FirewallSteps.Lines(result.StandardOutput)).FirstOrDefault();
            throw new ProcessFailedException($"{tool} {string.Join(' ', arguments)} failed{(said is null ? $" (exit code {result.ExitCode})" : $": {said}")}");
        }

        return result.StandardOutput;
    }

    private static IEnumerable<string> ServiceNames(string richRule)
    {
        var match = RichService().Match(richRule);
        return match.Success ? [match.Groups["name"].Value] : [];
    }

    private static FirewallPolicy Target(string target) => target.Trim() switch
    {
        "ACCEPT" => FirewallPolicy.Allow,
        "DROP" => FirewallPolicy.Deny,
        _ => FirewallPolicy.Reject,
    };

    private static string Protocol(FirewallRule rule) => rule.Protocol == FirewallProtocol.Udp ? "udp" : "tcp";

    private static FirewallStep Command(string program, string[] arguments) => new(
        $"{Path.GetFileName(program)} {string.Join(' ', arguments.Select(argument => argument.Contains(' ', StringComparison.Ordinal) ? $"'{argument}'" : argument))}",
        new ProcessSpec { Program = program, Arguments = arguments, Timeout = TimeSpan.FromMinutes(2) });

    [GeneratedRegex("^[A-Za-z0-9_+-]{1,32}$", RegexOptions.CultureInvariant)]
    private static partial Regex ZoneName();

    [GeneratedRegex("^[A-Za-z0-9_.+-]{1,64}$", RegexOptions.CultureInvariant)]
    private static partial Regex ServiceName();

    [GeneratedRegex("service name=\"(?<name>[^\"]{1,64})\"", RegexOptions.CultureInvariant)]
    private static partial Regex RichService();
}
