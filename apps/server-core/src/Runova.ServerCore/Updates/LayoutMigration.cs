using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Hosting;

namespace Runova.ServerCore.Updates;

/// <summary>
/// One step of moving a server from the legacy layout to the Runova one: a shell script that does
/// it and one that undoes it. Both may run more than once (a resumed or rolled-back migration
/// repeats the step it stopped in), so each checks what is already done before it acts.
/// </summary>
internal sealed record LayoutMigrationStep(string Name, string Description, string Do, string Undo);

/// <summary>
/// The migration's record, kept outside both state folders (<see cref="LayoutMigrationPlan.JournalPath"/>)
/// so it survives the move. Written before each step starts and after it ends.
/// </summary>
internal sealed record LayoutMigrationJournal
{
    public Guid Id { get; init; }

    public LayoutMigrationPhase Phase { get; init; }

    /// <summary>The release folder the legacy core ran from, which is what a rollback goes back to.</summary>
    public required string LegacyRelease { get; init; }

    public required string NewRelease { get; init; }

    /// <summary>The steps that finished, in order.</summary>
    public IReadOnlyList<string> Completed { get; init; } = [];

    /// <summary>The step under way when the journal was written, if any.</summary>
    public string? Current { get; init; }

    public string? Error { get; init; }

    public long StartedAt { get; init; }

    public long? FinishedAt { get; init; }
}

/// <summary>Reads and writes the journal: root only, replaced in one rename so a crash leaves the old or the new.</summary>
internal sealed class LayoutMigrationJournalFile(string path)
{
    private static readonly JsonSerializerOptions _json = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };

    public string Path { get; } = path;

    /// <summary>The journal, or null when there is none or it cannot be read.</summary>
    public LayoutMigrationJournal? Read()
    {
        try
        {
            return File.Exists(Path) ? JsonSerializer.Deserialize<LayoutMigrationJournal>(File.ReadAllText(Path), _json) : null;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }
    }

    public void Write(LayoutMigrationJournal journal)
    {
        var temporary = Path + ".new";
        var options = new FileStreamOptions { Mode = FileMode.Create, Access = FileAccess.Write };
        if (!OperatingSystem.IsWindows())
        {
            options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        }

        using (var stream = new FileStream(temporary, options))
        {
            JsonSerializer.Serialize(stream, journal, _json);
            stream.Flush(flushToDisk: true);
        }

        File.Move(temporary, Path, overwrite: true);
    }

    /// <summary>Why the last migration was put back, while the server is still on the legacy layout.</summary>
    public string? RolledBackError() =>
        Read() is { Phase: LayoutMigrationPhase.RolledBack or LayoutMigrationPhase.Failed } journal ? journal.Error : null;

    public LayoutMigrationStatus Status(CoreLayout layout)
    {
        ArgumentNullException.ThrowIfNull(layout);
        var name = layout.Kind == CoreLayoutKind.Runova ? CoreLayoutName.Runova : CoreLayoutName.Legacy;
        var journal = Read();
        if (journal is null)
        {
            return new LayoutMigrationStatus(name, layout.Kind == CoreLayoutKind.Runova ? LayoutMigrationPhase.Done : LayoutMigrationPhase.None);
        }

        var step = journal.Current is { } current
            ? LayoutMigrationPlan.Describe(current)
            : null;
        return new LayoutMigrationStatus(name, journal.Phase, step, journal.Error, journal.StartedAt, journal.FinishedAt);
    }
}

/// <summary>
/// What moving a server from the legacy layout to the Runova one does, as shell scripts run as
/// root. The core is stopped while its folders move; the old paths stay behind as links, since
/// running containers bind-mount absolute paths inside them and old apps look there.
/// </summary>
internal static class LayoutMigrationPlan
{
    /// <summary>Outside both state folders, so the record survives their move.</summary>
    public const string JournalPath = "/var/lib/.runova-migration.json";

    /// <summary>Puts the old runtime folder back as a link to the new one at every boot.</summary>
    public const string RuntimeLinkConfig = "/etc/tmpfiles.d/runova-core-compat.conf";

    /// <summary>How long the new core has to stay up after it started before the migration counts.</summary>
    public static readonly TimeSpan HealthWatch = TimeSpan.FromSeconds(10);

    public const string Stop = "stop";
    public const string Cutover = "cutover";

    private static readonly Dictionary<string, string> _descriptions = new(StringComparer.Ordinal)
    {
        ["release"] = "Copying the release into the Runova layout",
        ["needrestart"] = "Keeping needrestart away from the core",
        [Stop] = "Stopping the old core",
        ["group"] = "Renaming the group",
        ["data"] = "Moving the state folder",
        ["config"] = "Moving the configuration folder",
        ["selinux"] = "Labelling the moved files for SELinux",
        [Cutover] = "Starting the core under its new name",
        ["runtime"] = "Linking the old socket folder to the new one",
        ["compat"] = "Linking the old program folder to the new one",
        ["finish"] = "Removing the old unit",
    };

    /// <summary>The step's name in words, for the status the app shows.</summary>
    public static string Describe(string step) => _descriptions.GetValueOrDefault(step, step);

    /// <summary>Where the release ends up in the Runova layout: the same folder name.</summary>
    public static string NewReleaseFor(string legacyRelease)
    {
        if (!SystemdCoreInstallation.IsReleasePath(legacyRelease, CoreLayout.Legacy))
        {
            throw new ArgumentException("Only a release folder of the legacy layout can be migrated.", nameof(legacyRelease));
        }

        return CoreLayout.Runova.Releases + legacyRelease[CoreLayout.Legacy.Releases.Length..];
    }

    /// <summary>The steps, in order. A rollback runs the undo scripts of the ones that ran, last first.</summary>
    public static IReadOnlyList<LayoutMigrationStep> Steps(string legacyRelease)
    {
        var from = CoreLayout.Legacy;
        var to = CoreLayout.Runova;
        var release = NewReleaseFor(legacyRelease);
        var oldRelease = Q(legacyRelease);
        var newRelease = Q(release);

        LayoutMigrationStep Step(string name, string[] doLines, string[] undoLines) =>
            new(name, Describe(name), Script(doLines), Script(undoLines));

        return
        [
            Step(
                "release",
                [
                    $"test -x {oldRelease}/{to.Binary} && test -f {oldRelease}/{to.UnitFile}",
                    $"mkdir -p {to.Releases}",
                    $"if [ ! -d {newRelease} ]; then rm -rf {newRelease}.new && cp -a {oldRelease} {newRelease}.new && mv -T {newRelease}.new {newRelease}; fi",
                    $"ln -sfn {newRelease} {to.Root}/current.new && mv -Tf {to.Root}/current.new {to.CurrentLink}",
                    $"install -m 0644 -o root -g root {newRelease}/{to.UnitFile} {to.UnitPath}",
                    "systemctl daemon-reload",
                ],
                [
                    $"rm -f {to.UnitPath}",
                    "systemctl daemon-reload",
                    $"rm -rf -- {to.Root}",
                ]),
            Step(
                "needrestart",
                [
                    $"if [ -d {Q(Platform.AptPackageManager.NeedrestartDirectory)} ]; then printf '%s' {Q(Platform.AptPackageManager.NeedrestartOverride)} > {to.NeedrestartOverridePath} && chmod 0644 {to.NeedrestartOverridePath}; fi",
                ],
                [
                    $"rm -f {to.NeedrestartOverridePath}",
                ]),
            Step(
                Stop,
                [
                    $"systemctl stop {from.Unit}",
                    $"! systemctl is-active --quiet {from.Unit}",
                ],
                [
                    $"systemctl reset-failed {from.Unit} 2>/dev/null || true",
                    $"systemctl start {from.Unit}",
                ]),
            Step(
                "group",
                [
                    $"if getent group {from.Group} >/dev/null && ! getent group {to.Group} >/dev/null; then groupmod -n {to.Group} {from.Group}; fi",
                    $"getent group {to.Group} >/dev/null",
                ],
                [
                    $"if getent group {to.Group} >/dev/null && ! getent group {from.Group} >/dev/null; then groupmod -n {from.Group} {to.Group}; fi",
                ]),
            Step("data", Move(from.DataDirectory, to.DataDirectory), MoveBack(from.DataDirectory, to.DataDirectory)),
            Step("config", Move(from.ConfigDirectory, to.ConfigDirectory), MoveBack(from.ConfigDirectory, to.ConfigDirectory)),
            Step(
                "selinux",
                [
                    $"if command -v selinuxenabled >/dev/null 2>&1 && selinuxenabled; then restorecon -R -i {to.Root} {to.DataDirectory} {to.ConfigDirectory}; fi",
                ],
                [
                    $"if command -v selinuxenabled >/dev/null 2>&1 && selinuxenabled; then restorecon -R -i {from.Root} {from.DataDirectory} {from.ConfigDirectory}; fi",
                ]),
            Step(
                Cutover,
                [
                    $"systemctl disable {from.Unit} >/dev/null 2>&1 || true",
                    $"systemctl enable {to.Unit} >/dev/null 2>&1",
                    // Type=notify: this returns once the new core listens, or fails outright.
                    $"systemctl start {to.Unit}",
                ],
                [
                    $"systemctl disable --now {to.Unit} >/dev/null 2>&1 || true",
                    $"systemctl reset-failed {to.Unit} 2>/dev/null || true",
                    $"systemctl enable {from.Unit} >/dev/null 2>&1 || true",
                ]),
            Step(
                "runtime",
                [
                    $"printf '%s\\n' {Q($"L+ {from.RuntimeDirectory} - - - - {to.RuntimeDirectory}")} > {RuntimeLinkConfig}",
                    $"chmod 0644 {RuntimeLinkConfig}",
                    $"systemd-tmpfiles --create {RuntimeLinkConfig}",
                ],
                [
                    $"rm -f {RuntimeLinkConfig}",
                    $"if [ -L {from.RuntimeDirectory} ]; then rm -f {from.RuntimeDirectory}; fi",
                ]),
            Step(
                "compat",
                [
                    $"ln -sfn {to.CurrentLink} {from.Root}/current.new && mv -Tf {from.Root}/current.new {from.CurrentLink}",
                ],
                [
                    $"ln -sfn {oldRelease} {from.Root}/current.new && mv -Tf {from.Root}/current.new {from.CurrentLink}",
                ]),
            Step(
                "finish",
                [
                    $"rm -f {from.UnitPath}",
                    "systemctl daemon-reload",
                ],
                [
                    $"test -f {from.UnitPath} || install -m 0644 -o root -g root {oldRelease}/{from.UnitFile} {from.UnitPath}",
                    "systemctl daemon-reload",
                ]),
        ];
    }

    /// <summary>
    /// After the migration holds: the old releases and staging folder go (the old program folder
    /// keeps only its current link). Not undone. Two minutes later, from a timer of its own: the
    /// migration and whoever started it still run from the old release, and a single-file program
    /// reads its own file again whenever it loads an assembly.
    /// </summary>
    public static string Cleanup(Guid migration) => Script(
    [
        $"systemd-run --collect --quiet --on-active=120s --unit={SystemdRunner.UnitName("cleanup", migration)} "
            + $"/bin/rm -rf -- {CoreLayout.Legacy.Releases} {CoreLayout.Legacy.Staging}",
    ]);

    /// <summary>
    /// Problems that stop a migration before it starts, one per line, from a script that changes
    /// nothing. The new folders must not be there yet, and the old ones must move within their
    /// file system (a mount point cannot be renamed).
    /// </summary>
    public static string PreflightScript()
    {
        var from = CoreLayout.Legacy;
        var to = CoreLayout.Runova;
        return Script(
        [
            $"systemctl is-active --quiet {from.Unit} || echo 'The {from.Unit} service is not running.'",
            .. new[] { to.Root, to.DataDirectory, to.ConfigDirectory }
                .Select(path => $"if [ -e {path} ] || [ -L {path} ]; then echo '{path} is already there.'; fi"),
            .. new[] { from.DataDirectory, from.ConfigDirectory }
                .Select(path => $"if mountpoint -q {path} 2>/dev/null; then echo '{path} is a mount point, so it cannot be moved.'; fi"),
            "true",
        ]);
    }

    /// <summary>Lists the core's transient units that are running or waiting (`systemctl list-units`).</summary>
    public static ProcessSpec ActiveUnits() => new()
    {
        Program = "systemctl",
        Arguments =
        [
            "list-units", "--all", "--no-legend", "--plain", "--state=active,activating,reloading",
            .. CoreLayout.TransientUnitPrefixes.Select(prefix => prefix + "*"),
        ],
        Timeout = TimeSpan.FromSeconds(30),
    };

    /// <summary>
    /// The units in a `systemctl list-units --plain` answer (unit, load, active, sub, description)
    /// that still run or wait, other than the core and the migration itself. A timer that already
    /// fired stays listed as active and elapsed, and a finished one-shot as exited; neither counts.
    /// </summary>
    public static IReadOnlyList<string> OtherUnits(string listing, string? ownUnit)
    {
        ArgumentNullException.ThrowIfNull(listing);
        var cores = new[] { CoreLayout.Legacy.UnitFile, CoreLayout.Runova.UnitFile };
        return
        [
            .. listing.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Select(line => line.Split(' ', StringSplitOptions.RemoveEmptyEntries))
                .Where(columns => columns.Length < 4 || columns[3] is not ("elapsed" or "exited" or "dead"))
                .Select(columns => columns[0])
                .Where(unit => !cores.Contains(unit, StringComparer.Ordinal))
                .Where(unit => ownUnit is null || !unit.StartsWith(ownUnit + ".", StringComparison.Ordinal))
                .Distinct(StringComparer.Ordinal),
        ];
    }

    /// <summary>Moves a folder within its file system and leaves a link at the old path.</summary>
    private static string[] Move(string from, string to) =>
    [
        $"if [ -d {from} ] && [ ! -L {from} ]; then mv -T {from} {to}; fi",
        $"if [ -d {to} ] && [ ! -e {from} ] && [ ! -L {from} ]; then ln -s {to} {from}; fi",
    ];

    private static string[] MoveBack(string from, string to) =>
    [
        $"if [ -L {from} ]; then rm -f {from}; fi",
        $"if [ -d {to} ] && [ ! -L {to} ] && [ ! -e {from} ]; then mv -T {to} {from}; fi",
    ];

    private static string Script(IEnumerable<string> lines) => "set -eu\n" + string.Join('\n', lines);

    private static string Q(string value) => SystemdCoreInstallation.Quote(value);
}

/// <summary>How a migration run ended, as the command's exit code says it.</summary>
internal enum LayoutMigrationExit
{
    Done = 0,
    RolledBack = 1,
    Refused = 2,
    Failed = 3,
}

/// <summary>
/// Runs the migration: checks it may start, then each step with the journal written around it,
/// the new core watched for a while after it starts, and every step undone, last first, when one
/// fails. `--resume` carries on from the journal; `--rollback` puts back what it lists.
/// </summary>
internal sealed class LayoutMigrationRunner(
    IProcessRunner runner,
    LayoutMigrationJournalFile journalFile,
    TimeProvider time,
    Func<CancellationToken, Task<bool>> newCoreAnswers,
    Func<CancellationToken, Task<IReadOnlyList<string>>> pendingChanges,
    TextWriter output)
{
    private static readonly TimeSpan _stepTimeout = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan _poll = TimeSpan.FromSeconds(1);

    /// <summary>This run's own unit, left out of the "nothing else is running" check.</summary>
    public string? OwnUnit { get; init; }

    /// <summary>How long the new core has to stay up after the cutover.</summary>
    public TimeSpan Watch { get; init; } = LayoutMigrationPlan.HealthWatch;

    private long Now => time.GetUtcNow().ToUnixTimeMilliseconds();

    public async Task<LayoutMigrationExit> StartAsync(string legacyRelease, CancellationToken cancellationToken)
    {
        var existing = journalFile.Read();
        if (existing?.Phase == LayoutMigrationPhase.Running)
        {
            Say("A migration is already under way. Run migrate-layout --resume or --rollback.");
            return LayoutMigrationExit.Refused;
        }

        if (existing?.Phase == LayoutMigrationPhase.Done)
        {
            Say("This server has moved to the Runova layout already.");
            return LayoutMigrationExit.Done;
        }

        IReadOnlyList<LayoutMigrationStep> steps;
        try
        {
            steps = LayoutMigrationPlan.Steps(legacyRelease);
        }
        catch (ArgumentException error)
        {
            Say(error.Message);
            return LayoutMigrationExit.Refused;
        }

        var problems = new List<string>();
        var preflight = await ShellAsync(LayoutMigrationPlan.PreflightScript(), cancellationToken);
        problems.AddRange(preflight.StandardOutput.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
        var units = await runner.RunAsync(LayoutMigrationPlan.ActiveUnits(), onLine: null, cancellationToken);
        problems.AddRange(LayoutMigrationPlan.OtherUnits(units.StandardOutput, OwnUnit).Select(unit => $"{unit} is still running."));
        problems.AddRange((await pendingChanges(cancellationToken)).Select(change => $"{change} is waiting to be confirmed."));
        if (problems.Count > 0)
        {
            foreach (var problem in problems)
            {
                Say(problem);
            }

            return LayoutMigrationExit.Refused;
        }

        var journal = new LayoutMigrationJournal
        {
            Id = Guid.NewGuid(),
            Phase = LayoutMigrationPhase.Running,
            LegacyRelease = legacyRelease,
            NewRelease = LayoutMigrationPlan.NewReleaseFor(legacyRelease),
            StartedAt = Now,
        };
        journalFile.Write(journal);
        return await RunStepsAsync(journal, steps, cancellationToken);
    }

    public async Task<LayoutMigrationExit> ResumeAsync(CancellationToken cancellationToken)
    {
        if (journalFile.Read() is not { Phase: LayoutMigrationPhase.Running } journal)
        {
            Say("There is no migration to resume.");
            return LayoutMigrationExit.Refused;
        }

        Say($"Resuming the migration started {DateTimeOffset.FromUnixTimeMilliseconds(journal.StartedAt).ToString("u", CultureInfo.InvariantCulture)}.");
        return await RunStepsAsync(journal, LayoutMigrationPlan.Steps(journal.LegacyRelease), cancellationToken);
    }

    public async Task<LayoutMigrationExit> RollbackAsync(CancellationToken cancellationToken)
    {
        if (journalFile.Read() is not { Phase: LayoutMigrationPhase.Running } journal)
        {
            Say("There is no unfinished migration to roll back.");
            return LayoutMigrationExit.Refused;
        }

        return await RollBackAsync(journal, LayoutMigrationPlan.Steps(journal.LegacyRelease), "It was rolled back on request.");
    }

    private async Task<LayoutMigrationExit> RunStepsAsync(LayoutMigrationJournal journal, IReadOnlyList<LayoutMigrationStep> steps, CancellationToken cancellationToken)
    {
        foreach (var step in steps.Where(step => !journal.Completed.Contains(step.Name)))
        {
            journal = journal with { Current = step.Name };
            journalFile.Write(journal);
            Say(step.Description + ".");
            string? failure;
            try
            {
                var result = await ShellAsync(step.Do, cancellationToken);
                failure = result.Succeeded ? null : $"{step.Description} failed: {Reason(result)}";
                if (failure is null && step.Name == LayoutMigrationPlan.Cutover)
                {
                    failure = await WatchNewCoreAsync(cancellationToken);
                }
            }
            catch (Exception error) when (error is ProcessStartException or IOException)
            {
                failure = $"{step.Description} failed: {error.Message}";
            }

            if (failure is not null)
            {
                Say(failure);
                return await RollBackAsync(journal, steps, failure);
            }

            journal = journal with { Completed = [.. journal.Completed, step.Name], Current = null };
            journalFile.Write(journal);
        }

        journalFile.Write(journal with { Phase = LayoutMigrationPhase.Done, Current = null, FinishedAt = Now });
        var cleanup = await ShellAsync(LayoutMigrationPlan.Cleanup(journal.Id), CancellationToken.None);
        if (!cleanup.Succeeded)
        {
            Say($"The old releases could not all be removed: {Reason(cleanup)}");
        }

        Say("The server core now runs in the Runova layout.");
        return LayoutMigrationExit.Done;
    }

    /// <summary>
    /// Undoes the steps that ran, and the one that failed (its undo checks what it finds), last
    /// first. Every undo is tried even when one fails, so as much as possible goes back.
    /// </summary>
    private async Task<LayoutMigrationExit> RollBackAsync(LayoutMigrationJournal journal, IReadOnlyList<LayoutMigrationStep> steps, string reason)
    {
        var ran = steps.Where(step => journal.Completed.Contains(step.Name) || step.Name == journal.Current).Reverse().ToList();
        var failed = new List<string>();
        foreach (var step in ran)
        {
            Say($"Undoing: {step.Description}.");
            try
            {
                var result = await ShellAsync(step.Undo, CancellationToken.None);
                if (!result.Succeeded)
                {
                    failed.Add($"{step.Description} ({Reason(result)})");
                }
            }
            catch (Exception error) when (error is ProcessStartException or IOException)
            {
                failed.Add($"{step.Description} ({error.Message})");
            }
        }

        var phase = failed.Count == 0 ? LayoutMigrationPhase.RolledBack : LayoutMigrationPhase.Failed;
        var message = failed.Count == 0
            ? reason
            : $"{reason} Putting it back did not fully work either: {string.Join("; ", failed)}.";
        journalFile.Write(journal with { Phase = phase, Current = null, Error = message, FinishedAt = Now });
        Say(failed.Count == 0 ? "Everything was put back; the server runs as it did." : message);
        return failed.Count == 0 ? LayoutMigrationExit.RolledBack : LayoutMigrationExit.Failed;
    }

    /// <summary>The new core has to answer and its unit stay active for <see cref="Watch"/>.</summary>
    private async Task<string?> WatchNewCoreAsync(CancellationToken cancellationToken)
    {
        var unit = CoreLayout.Runova.Unit;
        if (!await newCoreAnswers(cancellationToken))
        {
            return "The new core started but does not answer on its socket.";
        }

        var until = time.GetUtcNow() + Watch;
        while (time.GetUtcNow() < until)
        {
            var active = await runner.RunAsync(
                new ProcessSpec { Program = "systemctl", Arguments = ["is-active", "--quiet", unit], Timeout = TimeSpan.FromSeconds(15) },
                onLine: null,
                cancellationToken);
            if (!active.Succeeded)
            {
                return $"The new core did not stay up (journalctl -u {unit} says why).";
            }

            await Task.Delay(_poll, time, cancellationToken);
        }

        return await newCoreAnswers(cancellationToken) ? null : "The new core stopped answering on its socket.";
    }

    private Task<ProcessResult> ShellAsync(string script, CancellationToken cancellationToken) =>
        runner.RunAsync(
            new ProcessSpec { Program = "/bin/sh", Arguments = ["-c", script], Timeout = _stepTimeout },
            onLine: null,
            cancellationToken);

    private static string Reason(ProcessResult result) =>
        result.TimedOut
            ? "it took too long"
            : (result.StandardError.Trim() is { Length: > 0 } error ? error : result.StandardOutput.Trim()) is { Length: > 0 } text
                ? text.Split('\n')[^1].Trim()
                : string.Create(CultureInfo.InvariantCulture, $"exit code {result.ExitCode}");

    /// <summary>Progress goes to the journal of the unit and, through systemd-run's pipe, to whoever started it; that pipe may be gone.</summary>
    private void Say(string line)
    {
        try
        {
            output.WriteLine(line);
            output.Flush();
        }
        catch (IOException)
        {
            // Nobody is reading any more (the SSH session ended); the unit carries on.
        }
    }
}
