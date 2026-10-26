using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Docker;
using Runova.ServerCore.Uploads;

namespace Runova.ServerCore.Files;

/// <param name="ListingByteCap">How much of an archive a listing without a shell reads before it stops and says it is partial.</param>
/// <param name="ListingOutputCap">How much lister output is read from a container with a shell.</param>
/// <param name="MaxListedEntries">How many entries one listing holds at most.</param>
internal sealed record FileServiceOptions(
    long ListingByteCap,
    int ListingOutputCap,
    int MaxListedEntries,
    TimeSpan SessionIdle,
    TimeSpan HelperIdle,
    TimeSpan SweepInterval,
    TimeSpan ExecTimeout)
{
    public static FileServiceOptions Default { get; } = new(
        256L * 1024 * 1024,
        32 * 1024 * 1024,
        100_000,
        TimeSpan.FromMinutes(15),
        TimeSpan.FromMinutes(5),
        TimeSpan.FromSeconds(30),
        TimeSpan.FromSeconds(60));
}

/// <summary>A file on its way down: its size and time, and its bytes. Disposing it ends the engine's stream.</summary>
internal sealed class FileDownload(long size, long mtimeUnixMs, Stream body, Stream archive) : IAsyncDisposable
{
    public long Size { get; } = size;

    public long MtimeUnixMs { get; } = mtimeUnixMs;

    public Stream Body { get; } = body;

    public ValueTask DisposeAsync() => archive.DisposeAsync();
}

/// <summary>
/// The file manager's sessions on containers and volumes (E27). A session lives here, not on a hub
/// connection, so the hub's browse calls and the REST transfers can all name it; it belongs to the
/// user who opened it and ends after 15 minutes unused. Everything goes through the Docker API:
/// <list type="bullet">
/// <item>With a shell (a running container that has sh, stat and readlink, or any volume), listing
/// and stat are a fixed script and rename, delete and chmod are execs, paths always as arguments.</item>
/// <item>Without one (stopped or distroless), listing reads the archive API's tar one level deep
/// up to a byte cap, and stat is its HEAD. Rename, delete and chmod are off, with the reason.</item>
/// <item>Uploads are wrapped into a one-entry tar owned like the folder they land in, written
/// under a .part name and moved into place when there is a shell, so a cut upload leaves nothing.</item>
/// <item>A volume is mounted at /data in a busybox helper, shared by the volume's sessions and
/// removed five minutes after the last one ends. Its real paths are checked to stay under /data,
/// so a link in the volume never leads the core anywhere else.</item>
/// </list>
/// </summary>
internal sealed partial class ContainerFilesService : IHostedService, IDisposable
{
    public const string StoppedLimitation = "The container is stopped. Start it to rename, delete or change permissions.";
    public const string PausedLimitation = "The container is paused. Unpause it to rename, delete or change permissions.";
    public const string NoShellLimitation = "This container has no shell, so files can be listed and copied but not renamed, deleted or changed.";
    private const string OutsideVolume = "That path leads out of the volume through a link, so it is not followed.";

    /// <summary>Uploads are written by the engine as root, so moving them into place runs as root too.</summary>
    private const string RootUser = "0";

    private const int SmallOutput = 64 * 1024;
    private const int MaxLinkHops = 8;

    private static readonly string[] _offlineSigns =
    [
        "dial tcp", "no such host", "server misbehaving", "i/o timeout", "network is unreachable",
        "connection refused", "TLS handshake timeout", "Client.Timeout", "temporary failure in name resolution",
    ];

    private readonly IDockerEngine _engine;
    private readonly TimeProvider _time;
    private readonly ILogger<ContainerFilesService> _logger;
    private readonly FileServiceOptions _options;
    private readonly ConcurrentDictionary<Guid, Session> _sessions = new();
    private readonly Lock _gate = new();
    private readonly Dictionary<string, Helper> _helpers = new(StringComparer.Ordinal);
    private readonly ITimer _timer;

    public ContainerFilesService(IDockerEngine engine, TimeProvider time, ILogger<ContainerFilesService> logger, FileServiceOptions options)
    {
        _engine = engine;
        _time = time;
        _logger = logger;
        _options = options;
        _timer = time.CreateTimer(_ => _ = SweepQuietlyAsync(), null, options.SweepInterval, options.SweepInterval);
    }

    private long Now => _time.GetUtcNow().ToUnixTimeMilliseconds();

    public Task StartAsync(CancellationToken cancellationToken)
    {
        // Helpers a previous core left behind go, without holding up the start.
        _ = Task.Run(
            async () =>
            {
                try
                {
                    await SweepLeftoversAsync(CancellationToken.None);
                }
                catch (Exception error) when (error is DockerUnavailableException or DockerRequestException or DockerNotFoundException)
                {
                    LogSweepFailed(_logger, error);
                }
            },
            CancellationToken.None);
        return Task.CompletedTask;
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        List<string> ids;
        lock (_gate)
        {
            ids = [.. _helpers.Values.Where(h => h.Ready.IsCompletedSuccessfully).Select(h => h.Ready.Result)];
            _helpers.Clear();
        }

        foreach (var id in ids)
        {
            await RemoveHelperQuietlyAsync(id, cancellationToken);
        }
    }

    public void Dispose() => _timer.Dispose();

    /// <summary>A description for the audit trail ("container:shop-web-1"), or null for no such session.</summary>
    public string? Describe(Guid sessionId) =>
        _sessions.TryGetValue(sessionId, out var session)
            ? $"{(session.Info.Target.Kind == FileTargetKind.Volume ? "volume" : "container")}:{session.Info.DisplayName}"
            : null;

    public async Task<FileSessionInfo> OpenAsync(FileTarget target, Guid owner, CancellationToken cancellationToken)
    {
        if (target is null || !Enum.IsDefined(target.Kind))
        {
            throw new FileOperationException(FileErrorCode.InvalidInput, "Open a container or a volume.");
        }

        try
        {
            var session = target.Kind == FileTargetKind.Volume
                ? await OpenVolumeAsync(target, owner)
                : await OpenContainerAsync(target, owner, cancellationToken);
            _sessions[session.Info.SessionId] = session;
            return session.Info;
        }
        catch (DockerNotFoundException)
        {
            throw new FileOperationException(FileErrorCode.TargetGone, $"There is no container called {target.Id}.");
        }
        catch (Exception error) when (Translate(error, target.Id) is { } translated)
        {
            throw translated;
        }
    }

    public Task CloseAsync(Guid sessionId, Guid user, CancellationToken cancellationToken)
    {
        End(Get(sessionId, user));
        return Task.CompletedTask;
    }

    /// <summary>Ends every session a user has open (their account went away, or they signed out everywhere).</summary>
    public void CloseAllFor(Guid user)
    {
        foreach (var session in _sessions.Values.Where(s => s.Owner == user))
        {
            End(session);
        }
    }

    public Task<FileListing> ListAsync(Guid sessionId, Guid user, string path, CancellationToken cancellationToken)
    {
        var shown = FilePaths.Normalize(path);
        return RunAsync(sessionId, user, shown, async (session, container) =>
        {
            var inside = FilePaths.Inside(shown, session.Root);
            if (!session.Shell)
            {
                return await ArchiveListingAsync(container, shown, inside, cancellationToken);
            }

            var result = await _engine.RunExecAsync(container, FileScripts.ListArgs(inside, session.Root), session.ExecUser, _options.ExecTimeout, _options.ListingOutputCap, cancellationToken);
            if (!result.Truncated && result.ExitCode != 0)
            {
                throw ScriptError(result, shown);
            }

            var parsed = Parse(result.Stdout, single: false);
            return new FileListing(shown, [.. parsed.Entries], parsed.Incomplete || result.Truncated);
        }, cancellationToken);
    }

    /// <summary>The entry at a path, a link as itself; null when nothing is there.</summary>
    public Task<FileEntry?> StatAsync(Guid sessionId, Guid user, string path, CancellationToken cancellationToken)
    {
        var shown = FilePaths.Normalize(path);
        return RunAsync(sessionId, user, shown, (session, container) => StatInsideAsync(session, container, FilePaths.Inside(shown, session.Root), shown, cancellationToken), cancellationToken);
    }

    /// <summary>The path with links resolved where there is a shell; its last name may be missing.</summary>
    public Task<string> RealpathAsync(Guid sessionId, Guid user, string path, CancellationToken cancellationToken)
    {
        var shown = FilePaths.Normalize(path);
        return RunAsync(sessionId, user, shown, async (session, container) =>
        {
            if (!session.Shell)
            {
                return shown;
            }

            var real = await RealInsideAsync(session, container, FilePaths.Inside(shown, session.Root), shown, cancellationToken);
            return FilePaths.Outside(real, session.Root)!;
        }, cancellationToken);
    }

    /// <summary>A new folder, 0755 and owned like its parent, by the archive API (so it works without a shell too).</summary>
    public Task MkdirAsync(Guid sessionId, Guid user, string path, CancellationToken cancellationToken)
    {
        var shown = FilePaths.Normalize(path);
        var name = FilePaths.Name(shown);
        return RunAsync<bool>(sessionId, user, shown, async (session, container) =>
        {
            if (shown == "/")
            {
                throw new FileOperationException(FileErrorCode.Exists, "The top folder is already there.");
            }

            var folder = await FolderInsideAsync(session, container, shown, cancellationToken);
            if (await _engine.StatPathAsync(container, FilePaths.Combine(folder, name), cancellationToken) is not null)
            {
                throw new FileOperationException(FileErrorCode.Exists, $"There is already something called {name} in {FilePaths.Parent(shown)}.");
            }

            var (uid, gid) = await FolderOwnerAsync(container, folder, cancellationToken);
            var archive = SingleEntryTarWriter.Folder(name, 0x1ED, uid, gid, _time.GetUtcNow());
            await _engine.PutArchiveAsync(container, folder, new MemoryStream(archive), cancellationToken);
            return true;
        }, cancellationToken);
    }

    /// <summary>Renames or moves an entry; a name that is taken is refused, never overwritten.</summary>
    public Task RenameAsync(Guid sessionId, Guid user, string from, string to, CancellationToken cancellationToken)
    {
        var source = FilePaths.Normalize(from);
        var destination = FilePaths.Normalize(to);
        return RunAsync<bool>(sessionId, user, source, async (session, container) =>
        {
            Require(session, session.Info.Capabilities.Rename);
            if (source == "/" || destination == "/")
            {
                throw new FileOperationException(FileErrorCode.InvalidInput, "The top folder cannot be renamed, or replaced.");
            }

            var insideFrom = await EntryInsideAsync(session, container, source, cancellationToken);
            var insideTo = await EntryInsideAsync(session, container, destination, cancellationToken);
            if (await _engine.StatPathAsync(container, insideTo, cancellationToken) is not null)
            {
                throw new FileOperationException(FileErrorCode.Exists, $"There is already something called {FilePaths.Name(destination)} there.");
            }

            var result = await _engine.RunExecAsync(container, FileScripts.MoveArgs(insideFrom, insideTo), session.ExecUser, _options.ExecTimeout, SmallOutput, cancellationToken);
            return result.ExitCode == 0 ? true : throw CommandError(result, source);
        }, cancellationToken);
    }

    /// <summary>One entry: a file or link is unlinked, a folder removed only when empty. The app walks folders itself.</summary>
    public Task RemoveAsync(Guid sessionId, Guid user, string path, bool directory, CancellationToken cancellationToken)
    {
        var shown = FilePaths.Normalize(path);
        return RunAsync<bool>(sessionId, user, shown, async (session, container) =>
        {
            Require(session, session.Info.Capabilities.Remove);
            if (shown == "/")
            {
                throw new FileOperationException(FileErrorCode.InvalidInput, "The top folder cannot be deleted.");
            }

            var inside = await EntryInsideAsync(session, container, shown, cancellationToken);
            var result = await _engine.RunExecAsync(
                container,
                directory ? FileScripts.RemoveFolderArgs(inside) : FileScripts.RemoveFileArgs(inside),
                session.ExecUser,
                _options.ExecTimeout,
                SmallOutput,
                cancellationToken);
            return result.ExitCode == 0 ? true : throw CommandError(result, shown);
        }, cancellationToken);
    }

    /// <summary>Sets the permission bits (0 to 07777) of what is at the path, through a link like chmod does.</summary>
    public Task ChmodAsync(Guid sessionId, Guid user, string path, int mode, CancellationToken cancellationToken)
    {
        var shown = FilePaths.Normalize(path);
        return RunAsync<bool>(sessionId, user, shown, async (session, container) =>
        {
            Require(session, session.Info.Capabilities.Chmod);
            if (mode is < 0 or > 0xFFF)
            {
                throw new FileOperationException(FileErrorCode.InvalidInput, "A mode is the permission bits only, 0 to 7777 in octal.");
            }

            var inside = FilePaths.Inside(shown, session.Root);
            if (session.Volume is not null)
            {
                // chmod follows a link; in a volume it gets the real path, so the link is read as the volume's.
                inside = await RealInsideAsync(session, container, inside, shown, cancellationToken);
            }

            var result = await _engine.RunExecAsync(container, FileScripts.ChmodArgs(inside, mode), session.ExecUser, _options.ExecTimeout, SmallOutput, cancellationToken);
            return result.ExitCode == 0 ? true : throw CommandError(result, shown);
        }, cancellationToken);
    }

    /// <summary>A file's bytes, through links, unwrapped from the archive API's tar.</summary>
    public Task<FileDownload> OpenDownloadAsync(Guid sessionId, Guid user, string path, CancellationToken cancellationToken)
    {
        var shown = FilePaths.Normalize(path);
        return RunAsync(sessionId, user, shown, async (session, container) =>
        {
            var inside = FilePaths.Inside(shown, session.Root);
            var real = session.Shell
                ? await RealInsideAsync(session, container, inside, shown, cancellationToken)
                : await FollowLinksAsync(container, inside, shown, allowMissing: false, cancellationToken);
            var archive = await _engine.GetArchiveAsync(container, real, cancellationToken);
            try
            {
                var file = await ArchiveUnwrap.ReadFirstFileAsync(archive, cancellationToken);
                return new FileDownload(file.Header.Size, Seconds(file.Header.MtimeUnixMs), file.Body, archive);
            }
            catch
            {
                await archive.DisposeAsync();
                throw;
            }
        }, cancellationToken);
    }

    /// <summary>
    /// Writes a file from a body of a known length, through a link to the file it points at. The
    /// body is wrapped into a one-entry tar as it is read, owned like the folder; with a shell it
    /// lands under a .part name and is moved into place, and a failure or a cancel removes the part.
    /// </summary>
    /// <param name="mode">Permission bits; null keeps those of the file it replaces, or 0644.</param>
    public Task<FileEntry> UploadAsync(Guid sessionId, Guid user, string path, long length, int? mode, Stream body, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(body);
        var shown = FilePaths.Normalize(path);
        if (shown == "/" || length < 0 || mode is < 0 or > 0xFFF)
        {
            throw new FileOperationException(FileErrorCode.InvalidInput, shown == "/" ? "Name the file to upload." : "The upload's length or mode is not valid.");
        }

        return RunAsync(sessionId, user, shown, async (session, container) =>
        {
            var inside = FilePaths.Inside(shown, session.Root);
            var target = session.Shell
                ? await RealInsideAsync(session, container, inside, shown, cancellationToken)
                : await FollowLinksAsync(container, inside, shown, allowMissing: true, cancellationToken);
            var folder = FilePaths.Parent(target);
            var name = FilePaths.Name(target);
            var existing = await _engine.StatPathAsync(container, target, cancellationToken);
            if (existing is not null && ListingParser.KindOf(existing.Mode) == FileEntryKind.Directory)
            {
                throw new FileOperationException(FileErrorCode.IsDirectory, $"{shown} is a folder.");
            }

            await RequireFolderAsync(container, folder, FilePaths.Parent(shown), cancellationToken);
            var (uid, gid) = await FolderOwnerAsync(container, folder, cancellationToken);
            var permissions = mode ?? (existing is not null && ListingParser.KindOf(existing.Mode) == FileEntryKind.File ? existing.Mode & 0xFFF : 0x1A4);
            var atomic = session.Info.Capabilities.AtomicUpload;
            var written = atomic ? PartName(name) : name;
            var part = FilePaths.Combine(folder, written);
            try
            {
                var spec = new TarEntrySpec(written, TarEntrySpec.RegularFile, length, permissions, uid, gid, _time.GetUtcNow());
                await _engine.PutArchiveAsync(container, folder, SingleEntryTarWriter.Wrap(spec, body), cancellationToken);
                if (atomic)
                {
                    var moved = await _engine.RunExecAsync(container, FileScripts.MoveArgs(part, target), RootUser, _options.ExecTimeout, SmallOutput, cancellationToken);
                    if (moved.ExitCode != 0)
                    {
                        throw CommandError(moved, shown);
                    }
                }
            }
            catch when (atomic)
            {
                await RemoveQuietlyAsync(container, part);
                throw;
            }

            var entry = await StatInsideAsync(session, container, target, shown, cancellationToken)
                ?? throw new FileOperationException(FileErrorCode.Server, $"{shown} was written but is not there now.");
            return entry with { Name = FilePaths.Name(shown) };
        }, cancellationToken);
    }

    /// <summary>Ends sessions unused for too long and removes helpers idle for too long.</summary>
    public async Task SweepIdleAsync(CancellationToken cancellationToken)
    {
        var now = Now;
        foreach (var session in _sessions.Values.Where(s => now - Interlocked.Read(ref s.LastUsedMs) >= _options.SessionIdle.TotalMilliseconds))
        {
            End(session);
        }

        List<string> idle = [];
        lock (_gate)
        {
            foreach (var (volume, helper) in _helpers.Where(h => h.Value.Sessions == 0 && now - h.Value.IdleSinceMs >= _options.HelperIdle.TotalMilliseconds).ToList())
            {
                _helpers.Remove(volume);
                if (helper.Ready.IsCompletedSuccessfully)
                {
                    idle.Add(helper.Ready.Result);
                }
            }
        }

        foreach (var id in idle)
        {
            await RemoveHelperQuietlyAsync(id, cancellationToken);
        }
    }

    /// <summary>Removes helpers (found by their label) that this core is not using: what a previous run left.</summary>
    public async Task SweepLeftoversAsync(CancellationToken cancellationToken)
    {
        var labelled = new List<string>();
        foreach (var label in VolumeHelpers.Labels)
        {
            labelled.AddRange(await _engine.ListLabelledContainersAsync(label, cancellationToken));
        }

        HashSet<string> inUse;
        lock (_gate)
        {
            inUse = [.. _helpers.Values.Where(h => h.Ready.IsCompletedSuccessfully).Select(h => h.Ready.Result)];
        }

        foreach (var id in labelled.Distinct(StringComparer.Ordinal).Where(id => !inUse.Contains(id)))
        {
            LogSweeping(_logger, id);
            await RemoveHelperQuietlyAsync(id, cancellationToken);
        }
    }

    private static string PartName(string name)
    {
        var suffix = $".runova-{RandomNumberGenerator.GetHexString(8, lowercase: true)}.part";
        var kept = name;
        while (Encoding.UTF8.GetByteCount("." + kept + suffix) > FilePaths.MaxNameBytes)
        {
            kept = kept[..^1];
        }

        return "." + kept + suffix;
    }

    /// <summary>The lister's output; anything else from it is the core's problem, not the caller's.</summary>
    private static ParsedListing Parse(byte[] output, bool single)
    {
        try
        {
            return ListingParser.Parse(output, single);
        }
        catch (InvalidDataException error)
        {
            throw new FileOperationException(FileErrorCode.Server, error.Message, error);
        }
    }

    private static long Seconds(long unixMs) => unixMs - (((unixMs % 1000) + 1000) % 1000);

    private static void Require(Session session, bool allowed)
    {
        if (!allowed)
        {
            throw new FileOperationException(FileErrorCode.Unsupported, session.Info.Limitation ?? "This is not possible here.");
        }
    }

    private Session Get(Guid sessionId, Guid user)
    {
        if (!_sessions.TryGetValue(sessionId, out var session) || session.Owner != user)
        {
            throw new FileOperationException(FileErrorCode.SessionGone, "These files are not open any more. Open them again.");
        }

        Interlocked.Exchange(ref session.LastUsedMs, Now);
        return session;
    }

    private void End(Session session)
    {
        if (_sessions.TryRemove(session.Info.SessionId, out _) && session.Volume is not null)
        {
            lock (_gate)
            {
                if (_helpers.TryGetValue(session.Volume, out var helper) && --helper.Sessions <= 0)
                {
                    helper.Sessions = 0;
                    helper.IdleSinceMs = Now;
                }
            }
        }
    }

    private async Task<Session> OpenContainerAsync(FileTarget target, Guid owner, CancellationToken cancellationToken)
    {
        if (!DockerNames.IsContainer(target.Id))
        {
            throw new FileOperationException(FileErrorCode.InvalidInput, "That is not a container id or name.");
        }

        var details = (await _engine.InspectContainerAsync(target.Id, cancellationToken)).Details;
        var state = details.Summary.State;
        var shell = state == ContainerState.Running && await HasShellAsync(details.Summary.Id, details.User, cancellationToken);
        var limitation = shell ? null : state switch
        {
            ContainerState.Running => NoShellLimitation,
            ContainerState.Paused => PausedLimitation,
            _ => StoppedLimitation,
        };
        var info = new FileSessionInfo(
            Guid.NewGuid(),
            target,
            details.Summary.Name,
            FilePaths.TryNormalize(details.WorkingDirectory, out var home) ? home : "/",
            details.User ?? "root",
            new FileCapabilities(shell, shell, shell, shell),
            limitation);
        return new Session(info, owner, details.Summary.Id, null, FilePaths.ContainerRoot, shell, details.User) { LastUsedMs = Now };
    }

    private async Task<Session> OpenVolumeAsync(FileTarget target, Guid owner)
    {
        if (!DockerNames.IsVolume(target.Id))
        {
            throw new FileOperationException(FileErrorCode.InvalidInput, "That is not a volume name.");
        }

        if ((await _engine.ListVolumesAsync(CancellationToken.None)).All(volume => volume.Name != target.Id))
        {
            throw new FileOperationException(FileErrorCode.TargetGone, $"There is no volume called {target.Id}.");
        }

        Helper helper;
        lock (_gate)
        {
            if (!_helpers.TryGetValue(target.Id, out var known))
            {
                known = new Helper(StartHelper(target.Id));
                _helpers[target.Id] = known;
            }

            known.Sessions++;
            helper = known;
        }

        try
        {
            await helper.Ready;
        }
        catch
        {
            lock (_gate)
            {
                helper.Sessions--;
                if (_helpers.GetValueOrDefault(target.Id) == helper)
                {
                    _helpers.Remove(target.Id);
                }
            }

            throw;
        }

        var info = new FileSessionInfo(Guid.NewGuid(), target, target.Id, "/", "root", new FileCapabilities(true, true, true, true), null);
        return new Session(info, owner, null, target.Id, FilePaths.VolumeRoot, true, RootUser) { LastUsedMs = Now };
    }

    /// <summary>Made once per volume and shared, so it does not use the opening caller's token.</summary>
    private async Task<string> StartHelper(string volume)
    {
        try
        {
            return await _engine.CreateHelperAsync(VolumeHelpers.For(volume), CancellationToken.None);
        }
        catch (DockerRequestException error)
        {
            var offline = _offlineSigns.Any(sign => error.Message.Contains(sign, StringComparison.OrdinalIgnoreCase));
            throw new FileOperationException(
                FileErrorCode.Server,
                offline
                    ? $"The server could not download the busybox image that volumes are browsed with. It looks offline: {error.Message}"
                    : $"Docker could not start the busybox helper that volumes are browsed with: {error.Message}");
        }
    }

    private async Task<bool> HasShellAsync(string container, string? user, CancellationToken cancellationToken)
    {
        try
        {
            var probe = await _engine.RunExecAsync(container, FileScripts.ProbeArgs(), user, TimeSpan.FromSeconds(10), 4096, cancellationToken);
            return probe.ExitCode == 0 && Encoding.UTF8.GetString(probe.Stdout).Trim() == "ok";
        }
        catch (DockerRequestException)
        {
            return false;
        }
    }

    /// <summary>
    /// Runs one call on a session's container, with the engine's refusals turned into coded file
    /// errors. A volume's helper that disappeared is made again once; a container that is gone or
    /// stopped ends the session.
    /// </summary>
    private async Task<T> RunAsync<T>(Guid sessionId, Guid user, string shown, Func<Session, string, Task<T>> call, CancellationToken cancellationToken)
    {
        var session = Get(sessionId, user);
        try
        {
            var container = await ContainerOfAsync(session);
            try
            {
                return await call(session, container);
            }
            catch (Exception error) when (session.Volume is not null && IsGoneOrStopped(error))
            {
                return await call(session, await ReplaceHelperAsync(session.Volume, container));
            }
        }
        catch (Exception error) when (IsGoneOrStopped(error))
        {
            End(session);
            throw error is DockerNotFoundException
                ? new FileOperationException(FileErrorCode.TargetGone, $"{session.Info.DisplayName} is not there any more.")
                : new FileOperationException(FileErrorCode.SessionGone, $"{session.Info.DisplayName} stopped since its files were opened. Open them again.");
        }
        catch (Exception error) when (Translate(error, shown) is { } translated)
        {
            throw translated;
        }
    }

    private static bool IsGoneOrStopped(Exception error) =>
        (error is DockerNotFoundException && error.Message.StartsWith("No such container", StringComparison.Ordinal))
        || (error is DockerRequestException && error.Message.Contains("is not running", StringComparison.Ordinal));

    /// <summary>The engine's words as a file error, or null for what is already one (or a cancel).</summary>
    private static FileOperationException? Translate(Exception error, string shown) => error switch
    {
        FileOperationException or OperationCanceledException => null,
        DockerPathNotFoundException => new(FileErrorCode.NotFound, $"There is nothing at {shown}.", error),
        DockerNotFoundException => new(FileErrorCode.TargetGone, error.Message, error),
        DockerRequestException when Says(error, "not a directory") => new(FileErrorCode.NotDirectory, $"{FilePaths.Parent(shown)} is not a folder.", error),
        DockerRequestException when Says(error, "read-only") || Says(error, "permission denied") || Says(error, "operation not permitted") =>
            new(FileErrorCode.PermissionDenied, $"Docker may not write there: {error.Message}", error),
        DockerRequestException when Says(error, "no space left") || Says(error, "quota") => new(FileErrorCode.DiskFull, "The disk is full.", error),
        DockerRequestException or DockerUnavailableException => new(FileErrorCode.Server, error.Message, error),
        InvalidDataException => new(FileErrorCode.InvalidInput, error.Message, error),
        ArchiveRejectedException => new(FileErrorCode.Server, error.Message, error),
        _ => null,
    };

    private static bool Says(Exception error, string words) => error.Message.Contains(words, StringComparison.OrdinalIgnoreCase);

    private async Task<string> ContainerOfAsync(Session session)
    {
        if (session.Volume is null)
        {
            return session.Container!;
        }

        Task<string> ready;
        lock (_gate)
        {
            if (!_helpers.TryGetValue(session.Volume, out var helper))
            {
                helper = new Helper(StartHelper(session.Volume)) { Sessions = _sessions.Values.Count(s => s.Volume == session.Volume) };
                _helpers[session.Volume] = helper;
            }

            ready = helper.Ready;
        }

        return await ready;
    }

    private async Task<string> ReplaceHelperAsync(string volume, string failed)
    {
        Task<string> ready;
        lock (_gate)
        {
            var helper = _helpers[volume];
            if (helper.Ready.IsCompletedSuccessfully && helper.Ready.Result == failed)
            {
                LogHelperGone(_logger, volume);
                helper.Ready = StartHelper(volume);
                _ = RemoveHelperQuietlyAsync(failed, CancellationToken.None);
            }

            ready = helper.Ready;
        }

        return await ready;
    }

    private async Task<FileEntry?> StatInsideAsync(Session session, string container, string inside, string shown, CancellationToken cancellationToken)
    {
        var name = shown == "/" ? "/" : FilePaths.Name(shown);
        if (session.Shell)
        {
            var args = inside == (session.Root.Length == 0 ? "/" : session.Root)
                ? FileScripts.StatArgs(inside, session.Root, ".")
                : FileScripts.StatArgs(FilePaths.Parent(inside), session.Root, FilePaths.Name(inside));
            var result = await _engine.RunExecAsync(container, args, session.ExecUser, _options.ExecTimeout, SmallOutput, cancellationToken);
            if (result.ExitCode is FileScripts.NotFoundExit or FileScripts.NotDirectoryExit)
            {
                return null;
            }

            if (result.ExitCode != 0)
            {
                throw ScriptError(result, shown);
            }

            var parsed = Parse(result.Stdout, single: true);
            return parsed.Entries.Count == 1 ? parsed.Entries[0] with { Name = name } : throw new FileOperationException(FileErrorCode.Server, $"The container did not describe {shown}.");
        }

        // A file where a folder was expected on the way reads as nothing there.
        if (await TryStatAsync(container, inside, cancellationToken) is not { } stat)
        {
            return null;
        }

        var kind = ListingParser.KindOf(stat.Mode);
        var (uid, gid) = kind is FileEntryKind.File or FileEntryKind.Directory or FileEntryKind.Symlink
            ? await HeaderOwnerAsync(container, kind == FileEntryKind.Directory ? ContentsOf(inside) : inside, cancellationToken)
            : (0, 0);
        return new FileEntry(name, kind, stat.Size, Seconds(stat.MtimeUnixMs), stat.Mode, uid, gid, stat.LinkTarget);
    }

    /// <summary>
    /// A path inside the serving container with its links resolved, the last name allowed to be
    /// missing. In a volume that is the Real script, which reads an absolute link from the
    /// volume's root and never leaves it; in a container, readlink -f.
    /// </summary>
    private async Task<string> RealInsideAsync(Session session, string container, string inside, string shown, CancellationToken cancellationToken)
    {
        var volume = session.Volume is not null;
        var result = await _engine.RunExecAsync(
            container,
            volume ? FileScripts.RealArgs(session.Root, inside) : FileScripts.RealpathArgs(inside),
            session.ExecUser,
            _options.ExecTimeout,
            SmallOutput,
            cancellationToken);
        if (result.ExitCode is FileScripts.NotDirectoryExit && volume)
        {
            throw new FileOperationException(FileErrorCode.NotDirectory, $"Something on the way to {shown} is not a folder.");
        }

        if (result.ExitCode is FileScripts.LoopExit && volume)
        {
            throw new FileOperationException(FileErrorCode.NotFound, $"{shown} leads through too many links.");
        }

        if (result.ExitCode != 0)
        {
            // Something on the way is missing, or is a file: say which.
            var parent = volume ? null : await TryStatAsync(container, FilePaths.Parent(inside), cancellationToken);
            throw parent is not null && ListingParser.KindOf(parent.Mode) is FileEntryKind.File or FileEntryKind.Other
                ? new FileOperationException(FileErrorCode.NotDirectory, $"{FilePaths.Parent(shown)} is not a folder.")
                : new FileOperationException(FileErrorCode.NotFound, $"There is nothing at {shown}.");
        }

        var real = Encoding.UTF8.GetString(result.Stdout);
        // readlink -f ends its line with a newline; the Real script prints the path alone.
        real = volume || !real.EndsWith('\n') ? real : real[..^1];
        return FilePaths.Outside(real, session.Root) is null
            ? throw new FileOperationException(FileErrorCode.PermissionDenied, OutsideVolume)
            : real;
    }

    /// <summary>
    /// Where an entry itself is, inside the serving container: in a volume, its folder's real path
    /// and its own name, so a rename or delete acts on that name (a link as itself) and nothing on
    /// the way can lead out.
    /// </summary>
    private async Task<string> EntryInsideAsync(Session session, string container, string shown, CancellationToken cancellationToken)
    {
        var inside = FilePaths.Inside(shown, session.Root);
        if (session.Volume is null)
        {
            return inside;
        }

        var folder = await RealInsideAsync(session, container, FilePaths.Parent(inside), FilePaths.Parent(shown), cancellationToken);
        return FilePaths.Combine(folder, FilePaths.Name(inside));
    }

    /// <summary>The folder a new entry goes into, inside the container: real and confined for a volume, and there.</summary>
    private async Task<string> FolderInsideAsync(Session session, string container, string shown, CancellationToken cancellationToken)
    {
        var folder = FilePaths.Inside(FilePaths.Parent(shown), session.Root);
        if (session.Volume is not null)
        {
            folder = await RealInsideAsync(session, container, folder, shown, cancellationToken);
        }

        await RequireFolderAsync(container, folder, FilePaths.Parent(shown), cancellationToken);
        return folder;
    }

    /// <summary>The archive API's stat, with a refusal (a file on the way) read as nothing there.</summary>
    private async Task<PathStat?> TryStatAsync(string container, string path, CancellationToken cancellationToken)
    {
        try
        {
            return await _engine.StatPathAsync(container, path, cancellationToken);
        }
        catch (DockerRequestException)
        {
            return null;
        }
    }

    private async Task RequireFolderAsync(string container, string folder, string shownFolder, CancellationToken cancellationToken)
    {
        var stat = await TryStatAsync(container, folder, cancellationToken);
        if (stat is null)
        {
            throw new FileOperationException(FileErrorCode.NotFound, $"The folder {shownFolder} is not there.");
        }

        if (ListingParser.KindOf(stat.Mode) is FileEntryKind.File or FileEntryKind.Other)
        {
            throw new FileOperationException(FileErrorCode.NotDirectory, $"{shownFolder} is not a folder.");
        }
    }

    /// <summary>Follows links with the archive API's stat, for a container without a shell.</summary>
    private async Task<string> FollowLinksAsync(string container, string inside, string shown, bool allowMissing, CancellationToken cancellationToken)
    {
        var current = inside;
        for (var hop = 0; hop <= MaxLinkHops; hop++)
        {
            var stat = await _engine.StatPathAsync(container, current, cancellationToken);
            if (stat is null)
            {
                return allowMissing ? current : throw new FileOperationException(FileErrorCode.NotFound, $"There is nothing at {shown}.");
            }

            if (stat.LinkTarget is not { } target)
            {
                return current;
            }

            current = FilePaths.Normalize(target.StartsWith('/') ? target : FilePaths.Combine(FilePaths.Parent(current), target));
        }

        throw new FileOperationException(FileErrorCode.NotFound, $"{shown} is a link that leads through too many others.");
    }

    private static string ContentsOf(string folder) => folder == "/" ? "/." : folder + "/.";

    /// <summary>Who owns a folder, from the first header of its archive.</summary>
    private Task<(int Uid, int Gid)> FolderOwnerAsync(string container, string folder, CancellationToken cancellationToken) =>
        HeaderOwnerAsync(container, ContentsOf(folder), cancellationToken);

    private async Task<(int Uid, int Gid)> HeaderOwnerAsync(string container, string path, CancellationToken cancellationToken)
    {
        await using var archive = await _engine.GetArchiveAsync(container, path, cancellationToken);
        var reader = new TarStreamReader(archive);
        while (await reader.ReadNextAsync(cancellationToken) is { } header)
        {
            if (header.Type != 'g')
            {
                return (header.Uid, header.Gid);
            }
        }

        return (0, 0);
    }

    /// <summary>A folder listed from the archive API's tar of its contents: depth-1 headers only, bodies skipped, up to the byte cap.</summary>
    private async Task<FileListing> ArchiveListingAsync(string container, string shown, string inside, CancellationToken cancellationToken)
    {
        var stat = await _engine.StatPathAsync(container, inside, cancellationToken)
            ?? throw new FileOperationException(FileErrorCode.NotFound, $"There is nothing at {shown}.");
        if (ListingParser.KindOf(stat.Mode) is FileEntryKind.File or FileEntryKind.Other)
        {
            throw new FileOperationException(FileErrorCode.NotDirectory, $"{shown} is not a folder.");
        }

        var entries = new List<FileEntry>();
        var partial = false;
        await using (var archive = await _engine.GetArchiveAsync(container, ContentsOf(inside), cancellationToken))
        {
            var reader = new TarStreamReader(new CappedReadStream(archive, _options.ListingByteCap));
            try
            {
                while (await reader.ReadNextAsync(cancellationToken) is { } header)
                {
                    var name = header.Name.StartsWith("./", StringComparison.Ordinal) ? header.Name[2..] : header.Name;
                    name = name.TrimEnd('/');
                    if (header.Type == 'g' || name.Length == 0 || name == "." || name.Contains('/', StringComparison.Ordinal))
                    {
                        continue;
                    }

                    if (entries.Count >= _options.MaxListedEntries)
                    {
                        partial = true;
                        break;
                    }

                    entries.Add(FromTar(header, name));
                }
            }
            catch (CappedReadStream.CapReachedException)
            {
                partial = true;
            }
        }

        var folders = entries.Where(e => e.Kind == FileEntryKind.Directory).Select(e => e.Name).ToHashSet(StringComparer.Ordinal);
        return new FileListing(
            shown,
            [.. entries.Select(e => e.Kind == FileEntryKind.Symlink && e.LinkTarget is { } target && folders.Contains(target.TrimEnd('/')) ? e with { LinkIsDirectory = true } : e)],
            partial);
    }

    private static FileEntry FromTar(TarEntryHeader header, string name)
    {
        var type = header.Type switch
        {
            '5' => 0x4000,
            '2' => 0xA000,
            '3' => 0x2000,
            '4' => 0x6000,
            '6' => 0x1000,
            _ => 0x8000,
        };
        var mode = type | (header.Mode & 0xFFF);
        return new FileEntry(
            name,
            ListingParser.KindOf(mode),
            header.Type == '5' ? 4096 : header.Size,
            Seconds(header.MtimeUnixMs),
            mode,
            header.Uid,
            header.Gid,
            header.Type == '2' ? header.LinkName : null);
    }

    private async Task RemoveQuietlyAsync(string container, string path)
    {
        try
        {
            await _engine.RunExecAsync(container, FileScripts.RemoveFileArgs(path), RootUser, TimeSpan.FromSeconds(15), SmallOutput, CancellationToken.None);
        }
        catch (Exception error) when (error is DockerRequestException or DockerNotFoundException or DockerUnavailableException)
        {
            LogPartLeft(_logger, path, error);
        }
    }

    private async Task RemoveHelperQuietlyAsync(string id, CancellationToken cancellationToken)
    {
        try
        {
            await _engine.RemoveHelperAsync(id, cancellationToken);
        }
        catch (Exception error) when (error is DockerRequestException or DockerUnavailableException or OperationCanceledException)
        {
            LogHelperLeft(_logger, id, error);
        }
    }

    private async Task SweepQuietlyAsync()
    {
        try
        {
            await SweepIdleAsync(CancellationToken.None);
        }
        catch (Exception error) when (error is DockerRequestException or DockerUnavailableException or DockerNotFoundException)
        {
            LogSweepFailed(_logger, error);
        }
    }

    /// <summary>What the lister or stat script's exit says, or the command's own words.</summary>
    private static FileOperationException ScriptError(ExecResult result, string shown) => result.ExitCode switch
    {
        FileScripts.NotFoundExit => new(FileErrorCode.NotFound, $"There is nothing at {shown}."),
        FileScripts.NotDirectoryExit => new(FileErrorCode.NotDirectory, $"{shown} is not a folder."),
        FileScripts.PermissionExit => new(FileErrorCode.PermissionDenied, $"The container's user may not open {shown}."),
        FileScripts.OutsideExit => new(FileErrorCode.PermissionDenied, OutsideVolume),
        _ => CommandError(result, shown),
    };

    /// <summary>A command's failure from its stderr: busybox and coreutils both end with strerror's words.</summary>
    private static FileOperationException CommandError(ExecResult result, string shown)
    {
        var text = Encoding.UTF8.GetString(result.Stderr.Length > 0 ? result.Stderr : result.Stdout).Trim();
        bool Has(string words) => text.Contains(words, StringComparison.OrdinalIgnoreCase);
        return true switch
        {
            _ when result.ExitCode == 127 && Has("not found") => new(FileErrorCode.Unsupported, $"The container cannot run that command: {text}"),
            _ when Has("No such file or directory") => new(FileErrorCode.NotFound, $"There is nothing at {shown}."),
            _ when Has("Permission denied") || Has("Operation not permitted") || Has("Read-only file system") => new(FileErrorCode.PermissionDenied, $"The container does not allow that for {shown}: {text}"),
            _ when Has("Directory not empty") => new(FileErrorCode.NotEmpty, $"{shown} is not empty."),
            _ when Has("Is a directory") => new(FileErrorCode.IsDirectory, $"{shown} is a folder."),
            _ when Has("Not a directory") => new(FileErrorCode.NotDirectory, $"Something on the way to {shown} is not a folder."),
            _ when Has("File exists") => new(FileErrorCode.Exists, $"There is already something at {shown}."),
            _ when Has("No space left on device") || Has("Disk quota exceeded") => new(FileErrorCode.DiskFull, "The disk is full."),
            _ => new(FileErrorCode.Server, text.Length > 0 ? $"The container answered: {text}" : $"The command ended with code {result.ExitCode?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "unknown"}."),
        };
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Removing helper container {Id}, left by an earlier run.")]
    private static partial void LogSweeping(ILogger logger, string id);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Could not sweep the file helper containers.")]
    private static partial void LogSweepFailed(ILogger logger, Exception error);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Could not remove helper container {Id}.")]
    private static partial void LogHelperLeft(ILogger logger, string id, Exception error);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Could not remove the partial upload {Path}.")]
    private static partial void LogPartLeft(ILogger logger, string path, Exception error);

    [LoggerMessage(Level = LogLevel.Information, Message = "The helper container for volume {Volume} went away; making a new one.")]
    private static partial void LogHelperGone(ILogger logger, string volume);

    /// <summary>One open session. LastUsedMs is a field so it can be read and written atomically.</summary>
    private sealed class Session(FileSessionInfo info, Guid owner, string? container, string? volume, string root, bool shell, string? execUser)
    {
        public long LastUsedMs;

        public FileSessionInfo Info { get; } = info;

        public Guid Owner { get; } = owner;

        public string? Container { get; } = container;

        public string? Volume { get; } = volume;

        /// <summary>Where the target's "/" is inside the container that serves it ("" or "/data").</summary>
        public string Root { get; } = root;

        /// <summary>Lists and stats with the lister script, and can rename, delete and chmod.</summary>
        public bool Shell { get; } = shell;

        /// <summary>Who execs run as: the container's own user (null for its default), or root in a helper.</summary>
        public string? ExecUser { get; } = execUser;
    }

    private sealed class Helper(Task<string> ready)
    {
        public Task<string> Ready { get; set; } = ready;

        public int Sessions { get; set; }

        public long IdleSinceMs { get; set; }
    }

    /// <summary>Counts what is read and stops past the cap, so a listing never reads a whole file system.</summary>
    private sealed class CappedReadStream(Stream inner, long cap) : Stream
    {
        private long _read;

        public override bool CanRead => true;

        public override bool CanSeek => false;

        public override bool CanWrite => false;

        public override long Length => throw new NotSupportedException();

        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public override int Read(byte[] buffer, int offset, int count) => Count(inner.Read(buffer, offset, count));

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) =>
            Count(await inner.ReadAsync(buffer, cancellationToken));

        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
            ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();

        public override void Flush()
        {
        }

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        private int Count(int read)
        {
            _read += read;
            return _read > cap ? throw new CapReachedException() : read;
        }

        public sealed class CapReachedException : Exception;
    }
}
