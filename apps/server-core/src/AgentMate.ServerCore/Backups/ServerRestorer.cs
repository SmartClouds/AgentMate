using System.Text.Json;
using AgentMate.ServerCore.Audit;
using AgentMate.ServerCore.Contracts;
using AgentMate.ServerCore.Hosting;

namespace AgentMate.ServerCore.Backups;

/// <summary>What a restore starts again on this server: compose projects by name, and the websites.</summary>
internal interface IRestoreTargets
{
    /// <summary>Deploys the project's live revision; null when it went up, or why not.</summary>
    Task<string?> StartProjectAsync(string project, CancellationToken cancellationToken);

    Task<string?> ApplyWebsitesAsync(CancellationToken cancellationToken);
}

/// <summary>What moving to a new address changed, and the hostnames whose DNS someone has to change by hand.</summary>
internal sealed record AddressMove(IReadOnlyList<AddressChange> Applied, IReadOnlyList<string> ManualDns);

/// <summary>Moves every setting that named the old address to the new one (T11).</summary>
internal interface IAddressRebinder
{
    Task<IReadOnlyList<AddressChange>> PlanAsync(string[] oldAddresses, string[] newAddresses, CancellationToken cancellationToken);

    Task<AddressMove> ApplyAsync(string[] oldAddresses, string[] newAddresses, CancellationToken cancellationToken);
}

/// <summary>
/// Brings a restored server up (E28). After a restore's swap, the state folder holds server/ from
/// the backup: volumes, saved images, the containers started by hand, the projects that ran, the
/// firewall rules and the old addresses. Each step runs on its own and says how it went. When every
/// step went, server/ is deleted; otherwise it stays so the person can fix the cause and run it
/// again. Firewall rules are not applied here: the app applies them like any firewall change, with
/// its confirmation, so a restore can never lock anyone out.
/// </summary>
internal sealed class ServerRestorer(
    CoreDirectories directories,
    IBackupDocker docker,
    IServerStateReader state,
    IRestoreTargets targets,
    IAddressRebinder rebinder,
    AuditLog audit) : IDisposable
{
    private readonly SemaphoreSlim _gate = new(1, 1);
    private volatile ServerRestoreStatus? _status;

    public void Dispose() => _gate.Dispose();

    /// <summary>The last or current run, or null when none ran since the core started.</summary>
    public ServerRestoreStatus? Status => _status;

    private string Folder => Path.Combine(directories.Data, ServerSnapshot.Folder);

    public async Task<PendingServerRestore?> PendingAsync(CancellationToken cancellationToken)
    {
        if (await ReadAsync(cancellationToken) is not { } snapshot)
        {
            return null;
        }

        var current = await state.AddressesAsync(cancellationToken);
        var rules = snapshot.Firewall?.Rules ?? [];
        var changes = new List<AddressChange>();
        if (Moved(snapshot.Addresses, current))
        {
            var map = AddressRebindPlanner.Map(snapshot.Addresses, current);
            changes.AddRange(await rebinder.PlanAsync(snapshot.Addresses, current, cancellationToken));
            changes.AddRange(AddressRebindPlanner.Plan(map, [], rules, [], []));
            rules = [.. rules.Select(rule => AddressRebindPlanner.Rewrite(rule, map))];
        }

        return new PendingServerRestore(
            snapshot.HostName,
            snapshot.CreatedAtUnixMs,
            snapshot.Addresses,
            current,
            snapshot.Volumes.Length,
            snapshot.Images.Count(image => image.File is not null),
            snapshot.Images.Count(image => image.File is null && image.Tags.Length > 0),
            snapshot.Containers.Length,
            snapshot.RunningProjects,
            rules,
            [.. changes],
            snapshot.LiveCopy);
    }

    /// <summary>Marks a run as started, so a status read right after the hub call finds it.</summary>
    public ServerRestoreStatus Queue()
    {
        var queued = new ServerRestoreStatus(BackupRunState.Running, [], [], [], null);
        _status = queued;
        return queued;
    }

    public async Task RunAsync(bool moveAddresses, CancellationToken cancellationToken)
    {
        if (!await _gate.WaitAsync(TimeSpan.Zero, cancellationToken))
        {
            return;
        }

        var steps = new List<ServerRestoreStep>();
        var applied = new List<AddressChange>();
        var manualDns = new List<string>();
        try
        {
            var snapshot = await ReadAsync(cancellationToken);
            if (snapshot is null)
            {
                _status = new ServerRestoreStatus(BackupRunState.Failed, [], [], [], "There is nothing to bring up: the restored state has no server folder.");
                return;
            }

            if (snapshot.Docker && !await docker.IsAvailableAsync(cancellationToken))
            {
                _status = new ServerRestoreStatus(BackupRunState.Failed, [], [], [], "Install Docker on this server first, then bring the restore up again.");
                return;
            }

            void Report() => _status = new ServerRestoreStatus(BackupRunState.Running, [.. steps], [.. applied], [.. manualDns], null);

            async Task StepAsync(string name, Func<Task<string?>> work)
            {
                steps.Add(new ServerRestoreStep(name, BackupTargetState.Uploading, null));
                Report();
                string? problem;
                try
                {
                    problem = await work();
                }
                catch (Exception error) when (error is not OperationCanceledException)
                {
                    problem = error.Message;
                }

                steps[^1] = new ServerRestoreStep(name, problem is null ? BackupTargetState.Succeeded : BackupTargetState.Failed, problem);
                Report();
            }

            foreach (var image in snapshot.Images.Where(image => image.File is not null))
            {
                await StepAsync($"Load image {image.Tags.FirstOrDefault() ?? image.Id}", async () =>
                {
                    await using var file = File.OpenRead(Path.Combine(Folder, "images", image.File!));
                    await docker.LoadImagesAsync(file, cancellationToken);
                    return null;
                });
            }

            foreach (var volume in snapshot.Volumes)
            {
                await StepAsync($"Put back volume {volume.Name}", async () =>
                {
                    await using var file = File.OpenRead(Path.Combine(Folder, "volumes", volume.File));
                    await docker.ImportVolumeAsync(new BackupVolume(volume.Name, volume.Driver, volume.Labels), file, cancellationToken);
                    return null;
                });
            }

            var current = await state.AddressesAsync(cancellationToken);
            if (moveAddresses && Moved(snapshot.Addresses, current))
            {
                await StepAsync("Move settings to the new address", async () =>
                {
                    var moved = await rebinder.ApplyAsync(snapshot.Addresses, current, cancellationToken);
                    applied.AddRange(moved.Applied);
                    manualDns.AddRange(moved.ManualDns);
                    return null;
                });
            }

            foreach (var project in snapshot.RunningProjects)
            {
                await StepAsync($"Start stack {project}", () => targets.StartProjectAsync(project, cancellationToken));
            }

            foreach (var container in snapshot.Containers)
            {
                await StepAsync($"Create container {container.Name}", async () =>
                {
                    await docker.RecreateContainerAsync(container, cancellationToken);
                    return null;
                });
            }

            await StepAsync("Websites", () => targets.ApplyWebsitesAsync(cancellationToken));

            var failed = steps.Count(step => step.State == BackupTargetState.Failed);
            var outcome = failed == 0 ? BackupRunState.Succeeded : failed == steps.Count ? BackupRunState.Failed : BackupRunState.PartlyFailed;
            _status = new ServerRestoreStatus(outcome, [.. steps], [.. applied], [.. manualDns], failed == 0 ? null : "Not every step went. Fix what failed and bring the restore up again.");
            if (failed == 0)
            {
                BackupArchive.TryDelete(Folder);
            }

            await audit.AppendAsync(
                new AuditEntry("backup.restore.server", failed == 0 ? AuditResult.Success : AuditResult.Failed, Target: snapshot.HostName, Parameters: new Dictionary<string, string?>
                {
                    ["steps"] = steps.Count.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    ["failed"] = failed.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    ["addressesMoved"] = applied.Count.ToString(System.Globalization.CultureInfo.InvariantCulture),
                }),
                CancellationToken.None);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>The server has a new address when none of the old public ones is among the new.</summary>
    internal static bool Moved(string[] oldAddresses, string[] newAddresses) =>
        oldAddresses.Length > 0 && newAddresses.Length > 0 && !oldAddresses.Intersect(newAddresses, StringComparer.OrdinalIgnoreCase).Any();

    private async Task<ServerSnapshot?> ReadAsync(CancellationToken cancellationToken)
    {
        var file = Path.Combine(Folder, "server.json");
        if (!File.Exists(file))
        {
            return null;
        }

        await using var stream = File.OpenRead(file);
        try
        {
            return await JsonSerializer.DeserializeAsync(stream, ServerSnapshotJson.Default.ServerSnapshot, cancellationToken);
        }
        catch (JsonException error)
        {
            throw new BackupRefusedException("The restored server's description is damaged.", error);
        }
    }
}
