using System.Security.Cryptography;
using System.Text.RegularExpressions;
using AgentMate.ServerCore.Contracts;

namespace AgentMate.ServerCore.Updates;

/// <summary>Why a core update was refused or stopped.</summary>
internal enum CoreUpdateError
{
    /// <summary>The request does not describe a release for this server.</summary>
    Invalid,

    /// <summary>Another update is under way, or one has just been switched to.</summary>
    Busy,

    /// <summary>What was uploaded is not the release the request describes.</summary>
    Mismatch,

    /// <summary>This core was not installed by the app, so it cannot replace itself.</summary>
    Unsupported,

    /// <summary>Unpacking or scheduling the switch failed on the server.</summary>
    Failed,
}

internal sealed class CoreUpdateException(CoreUpdateError error, string message) : Exception(message)
{
    public CoreUpdateError Error { get; } = error;

    /// <summary>The camelCase code REST refusals carry.</summary>
    public string Code => Error switch
    {
        CoreUpdateError.Invalid => "invalid",
        CoreUpdateError.Busy => "busy",
        CoreUpdateError.Mismatch => "mismatch",
        CoreUpdateError.Unsupported => "unsupported",
        _ => "failed",
    };
}

/// <summary>What a core update request must look like before anything is fetched or written.</summary>
internal static partial class CoreUpdateRules
{
    /// <summary>Far above a release (about 40 MB), far below a full disk.</summary>
    public const long MaxSize = 256L * 1024 * 1024;

    /// <summary>The request's problem, or null when it names a release for <paramref name="rid"/>.</summary>
    public static string? Problem(CoreUpdateRequest? request, string rid)
    {
        if (request is null)
        {
            return "Say which release to switch to.";
        }

        if (request.Version is null || !Version().IsMatch(request.Version))
        {
            return "That is not a release version.";
        }

        if (request.File != $"agentmate-core-{request.Version}-{rid}.tar.gz")
        {
            return $"This server needs the {rid} build of core {request.Version}.";
        }

        if (request.Sha256 is null || !Sha256().IsMatch(request.Sha256))
        {
            return "The release checksum is not a SHA-256.";
        }

        if (request.Size is <= 0 or > MaxSize)
        {
            return "The release size is not right.";
        }

        if (request.DownloadUrl is { } url)
        {
            var match = ReleaseUrl().Match(url);
            if (!match.Success || match.Groups[1].Value != request.File)
            {
                return "That is not the address of this release on GitHub.";
            }
        }

        return null;
    }

    [GeneratedRegex("^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$", RegexOptions.CultureInvariant)]
    private static partial Regex Version();

    [GeneratedRegex("^[0-9a-f]{64}$", RegexOptions.CultureInvariant)]
    private static partial Regex Sha256();

    // The same shape the app's installer lets a server download over SSH (serverDownload.ts).
    [GeneratedRegex(@"^https://github\.com/[0-9A-Za-z_.-]+/[0-9A-Za-z_.-]+/releases/download/v[0-9A-Za-z][0-9A-Za-z.+-]{0,63}/(agentmate-core-[0-9A-Za-z.+-]+-linux-(?:x64|arm64)\.tar\.gz)$", RegexOptions.CultureInvariant)]
    private static partial Regex ReleaseUrl();
}

/// <summary>
/// The core replacing itself with another release, without SSH. The core fetches the release from
/// GitHub when it can; otherwise the app uploads it. Either way the tarball lands in a folder only
/// root can write to and must match the size and SHA-256 from the app's own manifest before it is
/// unpacked beside the running release. The switch itself runs from a transient unit a few
/// seconds later, so the app hears the answer before the core restarts, and the unit goes back to
/// the release before if the new one does not stay up.
/// </summary>
internal sealed class CoreUpdater(ICoreInstallation installation, IHttpClientFactory httpClients, TimeProvider time)
{
    public const string HttpClientName = "core-update";

    /// <summary>How long the core tries GitHub before the app is told to upload instead.</summary>
    public static readonly TimeSpan DownloadTimeout = TimeSpan.FromMinutes(5);

    /// <summary>After a switch is scheduled, new updates wait this long for it (the restart ends the wait sooner).</summary>
    public static readonly TimeSpan SwitchGrace = TimeSpan.FromMinutes(5);

    private const int CopyBuffer = 128 * 1024;

    private readonly Lock _gate = new();
    private bool _busy;
    private DateTimeOffset? _switchScheduledAt;

    /// <summary>Downloads the release from GitHub, checks it and schedules the switch.</summary>
    public async Task<CoreUpdateResult> DownloadAsync(CoreUpdateRequest request, CancellationToken cancellationToken)
    {
        if (Unsupported() is { } unsupported)
        {
            return unsupported;
        }

        Check(request);
        if (request.DownloadUrl is not { } url)
        {
            throw new CoreUpdateException(CoreUpdateError.Invalid, "Say where to download the release from, or upload it.");
        }

        return await ExclusiveAsync(async () =>
        {
            var tarball = PrepareStaging(request);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(DownloadTimeout);
            try
            {
                using var client = httpClients.CreateClient(HttpClientName);
                using var response = await client.GetAsync(new Uri(url), HttpCompletionOption.ResponseHeadersRead, timeout.Token);
                if (!response.IsSuccessStatusCode)
                {
                    ClearStaging();
                    return DownloadFailed($"GitHub answered {(int)response.StatusCode} {response.ReasonPhrase}.");
                }

                await using var body = await response.Content.ReadAsStreamAsync(timeout.Token);
                await SaveCheckedAsync(body, tarball, request, timeout.Token);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                ClearStaging();
                return DownloadFailed($"The download did not finish within {DownloadTimeout.TotalMinutes:0} minutes.");
            }
            catch (HttpRequestException error)
            {
                ClearStaging();
                return DownloadFailed(error.Message);
            }
            catch (IOException error)
            {
                ClearStaging();
                return DownloadFailed(error.Message);
            }
            catch (CoreUpdateException error) when (error.Error == CoreUpdateError.Mismatch)
            {
                ClearStaging();
                return DownloadFailed(error.Message);
            }

            return await SwitchAsync(tarball, request, cancellationToken);
        });
    }

    /// <summary>Takes the release from the app (the upload's body), checks it and schedules the switch.</summary>
    public async Task<CoreUpdateResult> ReceiveAsync(CoreUpdateRequest request, Stream body, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(body);
        if (Unsupported() is { } unsupported)
        {
            throw new CoreUpdateException(CoreUpdateError.Unsupported, unsupported.Problem!);
        }

        Check(request);
        return await ExclusiveAsync(async () =>
        {
            var tarball = PrepareStaging(request);
            try
            {
                await SaveCheckedAsync(body, tarball, request, cancellationToken);
            }
            catch
            {
                ClearStaging();
                throw;
            }

            return await SwitchAsync(tarball, request, cancellationToken);
        });
    }

    private CoreUpdateResult? Unsupported() =>
        installation.CurrentRelease is null || installation.Rid is null
            ? new CoreUpdateResult(
                CoreUpdateOutcome.Unsupported,
                CoreVersion.Current,
                "This core was not installed by the app, so it cannot replace itself. Update it over SSH instead.")
            : null;

    private void Check(CoreUpdateRequest request)
    {
        if (CoreUpdateRules.Problem(request, installation.Rid!) is { } problem)
        {
            throw new CoreUpdateException(CoreUpdateError.Invalid, problem);
        }

        if (installation.ReleaseDirectory(request.Version, request.Sha256) == installation.CurrentRelease)
        {
            throw new CoreUpdateException(CoreUpdateError.Invalid, $"This server already runs core {request.Version}.");
        }
    }

    private async Task<CoreUpdateResult> ExclusiveAsync(Func<Task<CoreUpdateResult>> work)
    {
        lock (_gate)
        {
            var switching = _switchScheduledAt is { } at && time.GetUtcNow() - at < SwitchGrace;
            if (_busy || switching)
            {
                throw new CoreUpdateException(
                    CoreUpdateError.Busy,
                    switching ? "The core is switching to a new release. Wait for it to come back." : "The core is already being updated.");
            }

            _busy = true;
        }

        try
        {
            var result = await work();
            if (result.Outcome == CoreUpdateOutcome.Switching)
            {
                lock (_gate)
                {
                    _switchScheduledAt = time.GetUtcNow();
                }
            }

            return result;
        }
        finally
        {
            lock (_gate)
            {
                _busy = false;
            }
        }
    }

    private async Task<CoreUpdateResult> SwitchAsync(string tarball, CoreUpdateRequest request, CancellationToken cancellationToken)
    {
        try
        {
            await installation.UnpackAndScheduleAsync(
                tarball,
                installation.ReleaseDirectory(request.Version, request.Sha256),
                request.Version,
                cancellationToken);
        }
        catch
        {
            ClearStaging();
            throw;
        }

        return new CoreUpdateResult(CoreUpdateOutcome.Switching, CoreVersion.Current);
    }

    private static CoreUpdateResult DownloadFailed(string problem) =>
        new(CoreUpdateOutcome.DownloadFailed, CoreVersion.Current, problem);

    /// <summary>A fresh staging folder, root's alone, and where the tarball goes in it.</summary>
    private string PrepareStaging(CoreUpdateRequest request)
    {
        ClearStaging();
        var directory = installation.StagingDirectory;
        if (OperatingSystem.IsWindows())
        {
            Directory.CreateDirectory(directory);
        }
        else
        {
            Directory.CreateDirectory(directory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }

        return Path.Combine(directory, request.File);
    }

    private void ClearStaging()
    {
        try
        {
            if (Directory.Exists(installation.StagingDirectory))
            {
                Directory.Delete(installation.StagingDirectory, recursive: true);
            }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            // Cleared again before the next update.
        }
    }

    /// <summary>
    /// Writes the stream to <paramref name="path"/>, hashing as it goes, and refuses it at the first
    /// byte past the size or, at the end, a size or checksum that is not the release's.
    /// </summary>
    private static async Task SaveCheckedAsync(Stream source, string path, CoreUpdateRequest request, CancellationToken cancellationToken)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var options = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write, Options = FileOptions.Asynchronous };
        if (!OperatingSystem.IsWindows())
        {
            options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        }

        long total = 0;
        await using (var file = new FileStream(path, options))
        {
            var buffer = new byte[CopyBuffer];
            int read;
            while ((read = await source.ReadAsync(buffer, cancellationToken)) > 0)
            {
                total += read;
                if (total > request.Size)
                {
                    throw new CoreUpdateException(CoreUpdateError.Mismatch, $"What arrived is larger than {request.File}, so it was not used.");
                }

                hash.AppendData(buffer, 0, read);
                await file.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
            }
        }

        if (total != request.Size)
        {
            throw new CoreUpdateException(CoreUpdateError.Mismatch, $"What arrived is smaller than {request.File}, so it was not used.");
        }

        if (!string.Equals(Convert.ToHexStringLower(hash.GetHashAndReset()), request.Sha256, StringComparison.Ordinal))
        {
            throw new CoreUpdateException(CoreUpdateError.Mismatch, $"What arrived does not match the checksum of {request.File}, so it was not used.");
        }
    }
}
