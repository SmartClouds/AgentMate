using System.Globalization;
using System.Runtime.CompilerServices;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Jobs;
using Runova.ServerCore.Registries;
using Runova.ServerCore.Security;
using Runova.ServerCore.Updates;

namespace Runova.ServerCore.Docker;

/// <summary>
/// What the hub's Docker methods do, on top of the engine: compose grouping, environment values
/// kept out of everything but the reveal, labels and logs redacted with the container's own
/// values, the stats of many containers merged into batches, consoles, prunes, events and the
/// install and pull jobs. Inputs arrive validated (the hub checks them and records refusals).
/// </summary>
internal sealed partial class DockerOperations(
    IDockerEngine engine,
    IDockerSetup setup,
    JobEngine jobs,
    Redactor redactor,
    TimeProvider time,
    ILogger<DockerOperations> logger,
    RegistryCredentials registries)
{
    public const string DockerLock = "docker";

    public const int MaxStatsContainers = 64;

    public const int DefaultLogTail = 200;

    public const int MaxLogTail = 5_000;

    public static readonly TimeSpan MinStatsInterval = TimeSpan.FromSeconds(1);

    public static readonly TimeSpan MaxStatsInterval = TimeSpan.FromSeconds(60);

    public static readonly TimeSpan DefaultStatsInterval = TimeSpan.FromSeconds(2);

    /// <summary>bash when the image has it, sh otherwise.</summary>
    public static readonly string[] DefaultShell = ["/bin/sh", "-c", "if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi"];

    private static readonly TimeSpan _statsRefresh = TimeSpan.FromSeconds(10);

    public async Task<DockerStatus> GetStatusAsync(CancellationToken cancellationToken)
    {
        var state = await setup.InspectAsync(cancellationToken);
        EngineVersion? version = null;
        EngineInfo? info = null;
        string? message = null;
        try
        {
            version = await engine.GetVersionAsync(cancellationToken);
            if (version is not null)
            {
                info = await engine.GetInfoAsync(cancellationToken);
            }
        }
        catch (DockerUnavailableException unavailable)
        {
            message = unavailable.Message;
        }

        var compose = DockerRepository.ParseComposeVersion(state.ComposeVersion);
        var installed = state.Installed || version is not null;
        message ??= !installed
            ? "Docker is not installed."
            : version is null
                ? "Docker is installed but not running."
                : compose is null
                    ? "Docker Compose is not installed."
                    : compose < DockerRepository.MinimumCompose
                        ? $"Docker Compose {compose} is older than {DockerRepository.MinimumCompose}, which the core needs."
                        : null;
        return new DockerStatus(
            installed,
            version is not null,
            compose is not null && compose >= DockerRepository.MinimumCompose,
            [.. state.ConflictingPackages],
            version?.Version,
            version?.NegotiatedApiVersion,
            compose?.ToString(),
            info?.StorageDriver,
            info?.CgroupVersion,
            message);
    }

    /// <summary>Compose projects by name with their containers by service, then the standalone ones.</summary>
    public async Task<ContainerList> ListAsync(CancellationToken cancellationToken)
    {
        var containers = await engine.ListContainersAsync(cancellationToken);
        var groups = containers
            .GroupBy(c => c.Summary.ComposeProject, StringComparer.Ordinal)
            .OrderBy(group => group.Key is null ? 1 : 0)
            .ThenBy(group => group.Key, StringComparer.Ordinal)
            .Select(group => new ContainerGroup(
                group.Key,
                [.. group
                    .Select(c => c.Summary)
                    .OrderBy(c => c.ComposeService ?? c.Name, StringComparer.Ordinal)
                    .ThenBy(c => c.ComposeNumber ?? 0)],
                group.Key is null ? null : group.Select(c => DockerMapping.Label(c.Labels, DockerMapping.WorkingDirectoryLabel)).FirstOrDefault(dir => dir is not null)));
        return new ContainerList([.. groups]);
    }

    /// <summary>Environment names only; label values pass through the redactor seeded with the environment.</summary>
    public async Task<ContainerDetails> InspectAsync(string container, CancellationToken cancellationToken)
    {
        var inspection = await engine.InspectContainerAsync(container, cancellationToken);
        var seeded = redactor.With(inspection.Environment.Select(entry => entry.Value));
        var details = inspection.Details;
        return details with
        {
            Labels = [.. details.Labels.Select(label => label with { Value = seeded.Redact(label.Value) })],
            Command = [.. details.Command.Select(seeded.Redact)],
            Entrypoint = [.. details.Entrypoint.Select(seeded.Redact)],
        };
    }

    public async Task<ContainerEnvVariable[]> RevealEnvironmentAsync(string container, CancellationToken cancellationToken)
    {
        var inspection = await engine.InspectContainerAsync(container, cancellationToken);
        return [.. inspection.Environment.Select(entry => new ContainerEnvVariable(entry.Key, entry.Value))];
    }

    /// <summary>The container's summary after a change, for the app to show at once.</summary>
    public async Task<ContainerSummary> SummaryAsync(string container, CancellationToken cancellationToken)
    {
        var containers = await engine.ListContainersAsync(cancellationToken);
        return containers.Select(c => c.Summary).FirstOrDefault(c => Matches(c, container))
            ?? throw new DockerNotFoundException($"No such container: {container}");
    }

    public async IAsyncEnumerable<ContainerStatsBatch> StreamStatsAsync(
        string[]? containerIds,
        TimeSpan interval,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var watch = new StatsWatch(engine, stop.Token);
        try
        {
            var refreshedAt = DateTimeOffset.MinValue;
            while (!cancellationToken.IsCancellationRequested)
            {
                if (refreshedAt == DateTimeOffset.MinValue || (containerIds is null && time.GetUtcNow() - refreshedAt >= _statsRefresh))
                {
                    IReadOnlyList<EngineContainer> listed;
                    try
                    {
                        listed = await engine.ListContainersAsync(cancellationToken);
                    }
                    catch (DockerUnavailableException unavailable)
                    {
                        LogStatsEnded(logger, unavailable.Message);
                        yield break;
                    }

                    watch.Follow(Wanted(listed, containerIds));
                    refreshedAt = time.GetUtcNow();
                }

                await Task.Delay(interval, time, cancellationToken);
                var (samples, stopped) = watch.Drain();
                if (watch.EngineLost && samples.Count == 0)
                {
                    yield break;
                }

                yield return new ContainerStatsBatch(time.GetUtcNow().ToUnixTimeMilliseconds(), [.. samples], [.. stopped]);
            }
        }
        finally
        {
            await stop.CancelAsync();
            await watch.DisposeAsync();
        }
    }

    public async IAsyncEnumerable<ContainerLogBatch> StreamLogsAsync(
        ContainerLogsRequest request,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        var inspection = await engine.InspectContainerAsync(request.ContainerId, cancellationToken);
        var reader = new ContainerLogReader(redactor.With(inspection.Environment.Select(entry => entry.Value)), request.AfterTimestamp);
        string? since = null;
        int? tail = Math.Clamp(request.Tail ?? DefaultLogTail, 0, MaxLogTail);
        if (DockerTime.TryParseNanoseconds(request.AfterTimestamp, out var after))
        {
            // Docker's since is inclusive; the reader drops the line already seen.
            since = DockerTime.ToEngineTime(after);
            tail = null;
        }
        else if (request.SinceUnixMs is long sinceMs and >= 0)
        {
            since = DockerTime.ToEngineTime(sinceMs * 1_000_000);
        }

        await foreach (var chunk in engine.ReadLogsAsync(inspection.Details.Summary.Id, new LogOptions(tail, since, request.Follow), cancellationToken))
        {
            var lines = reader.Add(chunk);
            if (lines.Count > 0)
            {
                yield return new ContainerLogBatch([.. lines]);
            }
        }

        var rest = reader.Flush();
        if (rest.Count > 0)
        {
            yield return new ContainerLogBatch([.. rest]);
        }
    }

    /// <summary>
    /// docker exec with a TTY. Input (keystrokes, sizes) is read alongside; output goes out as
    /// text, a split UTF-8 sequence kept for the next read. The last message says it ended.
    /// </summary>
    public async IAsyncEnumerable<ConsoleOutput> ConsoleAsync(
        ConsoleRequest request,
        IReadOnlyList<string> command,
        IAsyncEnumerable<ConsoleInput> input,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(input);
        var session = await engine.StartExecAsync(
            request.ContainerId,
            new ExecOptions(command, request.User, ClampColumns(request.Columns), ClampRows(request.Rows)),
            cancellationToken);
        await using (session)
        {
            using var stop = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            var typing = ForwardInputAsync(session, input, stop.Token);
            var decoder = new System.Text.UTF8Encoding(false).GetDecoder();
            var buffer = new byte[8 * 1024];
            var characters = new char[buffer.Length + 4];
            while (true)
            {
                var read = await session.ReadAsync(buffer, cancellationToken);
                if (read == 0)
                {
                    break;
                }

                var count = decoder.GetChars(buffer, 0, read, characters, 0, flush: false);
                if (count > 0)
                {
                    yield return new ConsoleOutput(new string(characters, 0, count));
                }
            }

            await stop.CancelAsync();
            await typing;
            using var exitWait = new CancellationTokenSource(TimeSpan.FromSeconds(5), time);
            int? exitCode = null;
            try
            {
                exitCode = await session.ExitCodeAsync(exitWait.Token);
            }
            catch (Exception error) when (error is OperationCanceledException or DockerRequestException or DockerNotFoundException or DockerUnavailableException)
            {
                // Unknown, then.
            }

            yield return new ConsoleOutput(Ended: true, ExitCode: exitCode);
        }
    }

    public Task StartContainerAsync(string container, CancellationToken cancellationToken) => engine.StartContainerAsync(container, cancellationToken);

    public Task StopContainerAsync(string container, int? timeoutSeconds, CancellationToken cancellationToken) =>
        engine.StopContainerAsync(container, timeoutSeconds, cancellationToken);

    public Task RestartContainerAsync(string container, int? timeoutSeconds, CancellationToken cancellationToken) =>
        engine.RestartContainerAsync(container, timeoutSeconds, cancellationToken);

    public Task PauseContainerAsync(string container, CancellationToken cancellationToken) => engine.PauseContainerAsync(container, cancellationToken);

    public Task UnpauseContainerAsync(string container, CancellationToken cancellationToken) => engine.UnpauseContainerAsync(container, cancellationToken);

    public Task KillContainerAsync(string container, string signal, CancellationToken cancellationToken) =>
        engine.KillContainerAsync(container, signal, cancellationToken);

    public Task RemoveContainerAsync(string container, bool removeVolumes, bool force, CancellationToken cancellationToken) =>
        engine.RemoveContainerAsync(container, removeVolumes, force, cancellationToken);

    public Task RemoveImageAsync(string image, bool force, CancellationToken cancellationToken) => engine.RemoveImageAsync(image, force, cancellationToken);

    public Task RemoveVolumeAsync(string volume, bool force, CancellationToken cancellationToken) => engine.RemoveVolumeAsync(volume, force, cancellationToken);

    public Task RemoveNetworkAsync(string network, CancellationToken cancellationToken) => engine.RemoveNetworkAsync(network, cancellationToken);

    public Task<IReadOnlyList<ImageInfo>> ListImagesAsync(CancellationToken cancellationToken) => engine.ListImagesAsync(cancellationToken);

    public Task<IReadOnlyList<VolumeInfo>> ListVolumesAsync(CancellationToken cancellationToken) => engine.ListVolumesAsync(cancellationToken);

    public Task<IReadOnlyList<NetworkInfo>> ListNetworksAsync(CancellationToken cancellationToken) => engine.ListNetworksAsync(cancellationToken);

    public Task<DockerDiskUsage> DiskUsageAsync(CancellationToken cancellationToken) => engine.GetDiskUsageAsync(cancellationToken);

    /// <summary>A system prune is containers, networks and images, then volumes when asked; the results add up.</summary>
    public async Task<DockerPruneResult> PruneAsync(DockerPruneRequest request, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (request.Target != DockerPruneTarget.System)
        {
            return await engine.PruneAsync(request.Target, request.AllImages, cancellationToken);
        }

        List<DockerPruneTarget> targets = [DockerPruneTarget.Containers, DockerPruneTarget.Networks, DockerPruneTarget.Images];
        if (request.IncludeVolumes)
        {
            targets.Add(DockerPruneTarget.Volumes);
        }

        var removed = 0;
        long reclaimed = 0;
        foreach (var target in targets)
        {
            var result = await engine.PruneAsync(target, request.AllImages, cancellationToken);
            removed += result.Removed;
            reclaimed += result.ReclaimedBytes;
        }

        return new DockerPruneResult(removed, reclaimed);
    }

    public async IAsyncEnumerable<DockerEvent> StreamEventsAsync(
        DockerEventsRequest request,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        long? after = long.TryParse(request?.AfterCursor, NumberStyles.None, CultureInfo.InvariantCulture, out var cursor) ? cursor : null;
        EventCursor? since = after is long from
            ? new EventCursor(from)
            : request?.SinceUnixMs is long sinceMs and >= 0 ? new EventCursor(sinceMs * 1_000_000) : null;
        await foreach (var engineEvent in engine.StreamEventsAsync(since, cancellationToken))
        {
            if (after is long last && engineEvent.TimeNano <= last)
            {
                continue;
            }

            yield return ToEvent(engineEvent);
        }
    }

    public Task<JobInfo> InstallAsync(bool removeConflicting, Requester who, CancellationToken cancellationToken) =>
        jobs.StartAsync(
            new JobRequest(JobKind.DockerInstall, "Install Docker", [SystemJobs.PackagesLock, DockerLock], "docker", who.UserId, who.UserName),
            (job, token) => setup.InstallAsync(removeConflicting, job, token),
            cancellationToken);

    /// <param name="login">
    /// A sign-in the app sent for the image's registry (E08); without one, the credential stored on
    /// this server for that registry is used, if there is one.
    /// </param>
    public Task<JobInfo> PullAsync(ImageReference image, Requester who, CancellationToken cancellationToken, RegistryLogin? login = null)
    {
        ArgumentNullException.ThrowIfNull(image);
        var name = image.ToString();
        var registry = RegistryNames.HostOfRepository(image.Repository);
        return jobs.StartAsync(
            new JobRequest(JobKind.ImagePull, $"Pull {name}", [$"image:{name}"], name, who.UserId, who.UserName),
            async (job, token) =>
            {
                var signIn = login ?? (await registries.UnsealAsync([registry], token)).FirstOrDefault();
                if (signIn is not null)
                {
                    job.Seed([signIn.Secret, RegistryAuthFolders.BasicAuth(signIn)]);
                    job.Log(signIn.Source == RegistryLoginSource.Request
                        ? $"Signing in to {signIn.Registry} as {signIn.Username} with the sign-in this pull brought."
                        : $"Signing in to {signIn.Registry} as {signIn.Username} with the credential stored on this server.");
                }

                var log = new PullLog(job, time);
                try
                {
                    await engine.PullImageAsync(image, log.Report, token, signIn);
                }
                catch (Exception error) when (error is DockerRequestException or DockerNotFoundException or DockerUnavailableException)
                {
                    throw new JobFailedException(error.Message);
                }

                job.Log($"{name} is ready.");
            },
            cancellationToken);
    }

    public static int ClampColumns(int columns) => Math.Clamp(columns, 2, 1_000);

    public static int ClampRows(int rows) => Math.Clamp(rows, 2, 500);

    public static TimeSpan ClampInterval(int? intervalMs) =>
        intervalMs is int ms
            ? TimeSpan.FromMilliseconds(Math.Clamp(ms, MinStatsInterval.TotalMilliseconds, MaxStatsInterval.TotalMilliseconds))
            : DefaultStatsInterval;

    /// <summary>Only well-known attributes leave the core; exec actions lose their command, which may hold a secret.</summary>
    private static DockerEvent ToEvent(EngineEvent engineEvent)
    {
        var attributes = engineEvent.Attributes;
        var action = engineEvent.Action.Split(':')[0].Trim();
        return new DockerEvent(
            engineEvent.Type,
            action,
            engineEvent.ActorId,
            engineEvent.TimeNano / 1_000_000,
            engineEvent.TimeNano.ToString(CultureInfo.InvariantCulture),
            attributes.GetValueOrDefault("name"),
            attributes.GetValueOrDefault("image"),
            attributes.GetValueOrDefault(DockerMapping.ProjectLabel),
            attributes.GetValueOrDefault(DockerMapping.ServiceLabel),
            int.TryParse(attributes.GetValueOrDefault("exitCode"), NumberStyles.Integer, CultureInfo.InvariantCulture, out var code) ? code : null);
    }

    private static bool Matches(ContainerSummary container, string reference) =>
        container.Id == reference
        || container.Name == reference
        || (reference.Length >= 12 && container.Id.StartsWith(reference, StringComparison.Ordinal));

    /// <summary>Running containers to follow: the ones asked for, or all of them (at most 64).</summary>
    private static List<string> Wanted(IReadOnlyList<EngineContainer> listed, string[]? containerIds)
    {
        var running = listed.Select(c => c.Summary).Where(c => c.State == ContainerState.Running).ToList();
        var wanted = containerIds is null
            ? running.Select(c => c.Id)
            : containerIds.Select(id => listed.Select(c => c.Summary).FirstOrDefault(c => Matches(c, id))?.Id ?? id);
        return [.. wanted.Distinct(StringComparer.Ordinal).Take(MaxStatsContainers)];
    }

    private static async Task ForwardInputAsync(IExecSession session, IAsyncEnumerable<ConsoleInput> input, CancellationToken cancellationToken)
    {
        try
        {
            await foreach (var item in input.WithCancellation(cancellationToken))
            {
                if (item is null)
                {
                    continue;
                }

                if (item.Columns is int columns && item.Rows is int rows)
                {
                    await session.ResizeAsync(ClampColumns(columns), ClampRows(rows), cancellationToken);
                }

                if (!string.IsNullOrEmpty(item.Data))
                {
                    await session.WriteAsync(System.Text.Encoding.UTF8.GetBytes(item.Data), cancellationToken);
                }
            }
        }
        catch (Exception error) when (error is OperationCanceledException or IOException or ObjectDisposedException or DockerRequestException or DockerNotFoundException or DockerUnavailableException)
        {
            // The console ended, or the app stopped sending; either way the output side decides.
        }
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "A stats stream ended: {Reason}")]
    private static partial void LogStatsEnded(ILogger logger, string reason);
}
