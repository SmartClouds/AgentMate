using System.Net;
using System.Text;
using System.Text.Json;
using Runova.ServerCore.Execution;

namespace Runova.ServerCore.Nginx;

/// <summary>PEM files nginx needs for one site's certificate.</summary>
internal sealed record NginxCertificateFiles(string SiteId, string ChainPem, string KeyPem);

/// <summary>
/// What to apply: the configuration, the certificate files it names, and what the caller records
/// once nginx runs it (kept in the crash marker, so a restarted core can record it too).
/// </summary>
internal sealed record NginxApplyPlan(
    NginxConfiguration Configuration,
    IReadOnlyList<NginxCertificateFiles> Certificates,
    NginxAppliedState State);

/// <summary>What nginx runs after an apply: a hash of the whole configuration and one per site and proxy.</summary>
internal sealed record NginxAppliedState(
    string Hash,
    IReadOnlyDictionary<string, string> Sites,
    IReadOnlyDictionary<string, string> Streams);

internal sealed record NginxApplyOutcome(
    bool Applied,
    IReadOnlyList<NginxProblem> Problems,
    IReadOnlyList<string> Warnings,
    int? Release = null,
    string? Error = null)
{
    public static NginxApplyOutcome Refused(IReadOnlyList<NginxProblem> problems, IReadOnlyList<string> warnings, string? error = null) =>
        new(false, problems, warnings, null, error);
}

/// <summary>Written before the current link moves, so a core that stops halfway knows what it was doing.</summary>
/// <param name="Phase">"switched" once the link points at the new release; "reloaded" once nginx runs it.</param>
internal sealed record NginxApplyMarker(int Release, int? Previous, string Phase, NginxAppliedState State, long StartedAtUnixMs)
{
    public const string Switched = "switched";
    public const string Reloaded = "reloaded";
}

/// <summary>Finds where an upstream name points, as nginx will when it loads the configuration.</summary>
internal interface IUpstreamResolver
{
    Task<IPAddress[]> ResolveAsync(string host, CancellationToken cancellationToken);
}

internal sealed class DnsUpstreamResolver : IUpstreamResolver
{
    public Task<IPAddress[]> ResolveAsync(string host, CancellationToken cancellationToken) =>
        Dns.GetHostAddressesAsync(host, cancellationToken);
}

/// <summary>
/// Puts a configuration live without ever leaving a broken one in place. Each apply renders a new
/// numbered release, moves the current link to it, runs nginx -t and reloads; the reload counts
/// only once nginx has started new workers. Anything short of that moves the link back (reloading
/// again if nginx might have half-taken it), deletes the release and returns the problems mapped
/// to what the person wrote. A marker file covers a core that stops in the middle: on start,
/// <see cref="RecoverAsync"/> finishes a release nginx already runs and undoes any other.
/// </summary>
internal sealed partial class NginxApplier(
    NginxControl control,
    NginxSeLinux seLinux,
    IUpstreamResolver resolver,
    UpstreamPolicy upstreams,
    TimeProvider time,
    ILogger<NginxApplier> logger) : IDisposable
{
    /// <summary>Releases kept besides the current one, so recent ones can be looked at.</summary>
    public const int KeptReleases = 5;

    private const UnixFileMode Readable = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead | UnixFileMode.OtherRead;
    private const UnixFileMode PrivateFile = UnixFileMode.UserRead | UnixFileMode.UserWrite;
    private const UnixFileMode PrivateFolder = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute;
    private const UnixFileMode OpenFolder = PrivateFolder | UnixFileMode.GroupRead | UnixFileMode.GroupExecute | UnixFileMode.OtherRead | UnixFileMode.OtherExecute;

    private static readonly TimeSpan _resolveTimeout = TimeSpan.FromSeconds(10);

    private readonly SemaphoreSlim _gate = new(1, 1);

    private INginxMachine Machine => control.Machine;

    public void Dispose() => _gate.Dispose();

    /// <summary>One apply at a time; the caller records the state and then calls <see cref="CompleteAsync"/> inside the same lease.</summary>
    public async Task<IDisposable> LockAsync(CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        return new Lease(_gate);
    }

    /// <summary>Checks the configuration as far as possible without nginx: the model, then where upstream names point.</summary>
    public async Task<IReadOnlyList<NginxProblem>> CheckAsync(NginxConfiguration configuration, NginxLayout layout, CancellationToken cancellationToken)
    {
        var problems = NginxValidator.Validate(configuration, layout, upstreams).ToList();
        if (problems.Count == 0)
        {
            problems.AddRange(await CheckResolvedUpstreamsAsync(configuration, cancellationToken));
        }

        return problems;
    }

    /// <summary>Call while holding <see cref="LockAsync"/>.</summary>
    public async Task<NginxApplyOutcome> ApplyAsync(NginxApplyPlan plan, NginxInspection inspection, NginxLayout layout, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(inspection);
        ArgumentNullException.ThrowIfNull(layout);
        var warnings = new List<string>();
        if (!inspection.Installed)
        {
            return NginxApplyOutcome.Refused([], warnings, "nginx is not installed on this server. Install it first.");
        }

        if (!inspection.Managed)
        {
            return NginxApplyOutcome.Refused([], warnings, "nginx is not set up for Runova yet. Run the nginx setup first.");
        }

        var configuration = plan.Configuration;
        if (configuration.Streams.Count > 0 && !inspection.StreamWired)
        {
            return NginxApplyOutcome.Refused(
                [new NginxProblem("streams", "This nginx cannot load TCP and UDP proxies: its stream module is missing. Install nginx from nginx.org to use them.")],
                warnings);
        }

        var problems = await CheckAsync(configuration, layout, cancellationToken);
        if (problems.Count > 0)
        {
            return NginxApplyOutcome.Refused(problems, warnings);
        }

        if (inspection.SeLinuxEnabled)
        {
            warnings.AddRange(await seLinux.PrepareForApplyAsync(configuration, cancellationToken));
        }

        await WriteCertificatesAsync(plan.Certificates, layout, cancellationToken);
        var releases = await ReleasesAsync(layout, cancellationToken);
        var previous = await control.CurrentReleaseAsync(layout, cancellationToken);
        var number = Math.Max(releases.DefaultIfEmpty(0).Max(), previous ?? 0) + 1;
        var release = NginxRenderer.Render(configuration, layout, upstreams, number);
        await WriteReleaseAsync(release, cancellationToken);

        var marker = new NginxApplyMarker(number, previous, NginxApplyMarker.Switched, plan.State, time.GetUtcNow().ToUnixTimeMilliseconds());
        await WriteMarkerAsync(layout, marker, cancellationToken);
        await PointAtAsync(layout, number, cancellationToken);

        var test = await control.TestAsync(cancellationToken);
        if (!test.Succeeded)
        {
            await UndoAsync(layout, number, previous, reload: false, cancellationToken);
            LogTestRefused(logger, number);
            return NginxApplyOutcome.Refused(NginxTestOutput.Problems(test.StandardError + test.StandardOutput, release, layout), warnings);
        }

        var reload = await control.ReloadAsync(inspection, layout, cancellationToken);
        if (!reload.Confirmed)
        {
            // nginx kept its old configuration, but a later reload must not pick this one up.
            await UndoAsync(layout, number, previous, reload: true, cancellationToken);
            LogReloadRefused(logger, number);
            return NginxApplyOutcome.Refused(NginxTestOutput.Problems(reload.Error, release, layout), warnings);
        }

        await WriteMarkerAsync(layout, marker with { Phase = NginxApplyMarker.Reloaded }, cancellationToken);
        LogApplied(logger, number);
        return new NginxApplyOutcome(true, [], warnings, number);
    }

    /// <summary>The caller recorded the state: the marker goes, and old releases and certificates with it.</summary>
    public async Task CompleteAsync(NginxApplyPlan plan, NginxLayout layout, int release, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(plan);
        await Machine.DeleteAsync(layout.ApplyMarker, cancellationToken);
        try
        {
            var releases = (await ReleasesAsync(layout, cancellationToken)).Where(number => number != release).OrderDescending().ToList();
            foreach (var old in releases.Skip(KeptReleases))
            {
                await Machine.DeleteAsync(layout.ReleaseDirectory(old), cancellationToken);
            }

            var keep = plan.Certificates.Select(files => files.SiteId).ToHashSet(StringComparer.Ordinal);
            foreach (var site in await Machine.ListAsync(layout.CertificatesDirectory, cancellationToken))
            {
                if (!keep.Contains(site))
                {
                    await Machine.DeleteAsync($"{layout.CertificatesDirectory}/{site}", cancellationToken);
                }
            }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            LogCleanupFailed(logger, error);
        }
    }

    /// <summary>
    /// After a restart: a release nginx already runs is finished (its state returned for the
    /// caller to record); one it may not run is undone. Null when there was nothing to do.
    /// </summary>
    public async Task<NginxApplyMarker?> RecoverAsync(NginxLayout layout, NginxInspection inspection, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(layout);
        ArgumentNullException.ThrowIfNull(inspection);
        var text = await Machine.ReadTextAsync(layout.ApplyMarker, cancellationToken);
        if (text is null)
        {
            return null;
        }

        NginxApplyMarker? marker;
        try
        {
            marker = JsonSerializer.Deserialize<NginxApplyMarker>(text, CoreJson.Options);
        }
        catch (JsonException)
        {
            marker = null;
        }

        if (marker is null)
        {
            LogMarkerUnreadable(logger);
            await Machine.DeleteAsync(layout.ApplyMarker, cancellationToken);
            return null;
        }

        if (marker.Phase == NginxApplyMarker.Reloaded)
        {
            LogRecoveredFinished(logger, marker.Release);
            return marker;
        }

        var current = await control.CurrentReleaseAsync(layout, cancellationToken);
        await UndoAsync(layout, marker.Release, marker.Previous, reload: current == marker.Release && inspection.Running, cancellationToken);
        LogRecoveredUndone(logger, marker.Release, marker.Previous);
        return marker with { Phase = NginxApplyMarker.Switched };
    }

    /// <summary>Back to the previous release (if the link moved), reloaded when nginx may have seen the new one, and the new one gone.</summary>
    private async Task UndoAsync(NginxLayout layout, int release, int? previous, bool reload, CancellationToken cancellationToken)
    {
        // Undoing must finish even when the request that started the apply is gone.
        using var budget = new CancellationTokenSource(TimeSpan.FromMinutes(2), time);
        var token = budget.Token;
        if (previous is { } back && await control.CurrentReleaseAsync(layout, token) == release)
        {
            await PointAtAsync(layout, back, token);
        }

        if (reload)
        {
            var inspection = await control.InspectAsync(layout, token);
            if (inspection.Running && (await control.TestAsync(token)).Succeeded)
            {
                var outcome = await control.ReloadAsync(inspection, layout, token);
                if (!outcome.Confirmed)
                {
                    LogUndoReloadFailed(logger, release);
                }
            }
        }

        await Machine.DeleteAsync(layout.ReleaseDirectory(release), token);
        await Machine.DeleteAsync(layout.ApplyMarker, token);
    }

    private Task PointAtAsync(NginxLayout layout, int release, CancellationToken cancellationToken) =>
        Machine.ReplaceLinkAsync(layout.CurrentLink, "releases/" + release.ToString(System.Globalization.CultureInfo.InvariantCulture), cancellationToken);

    private async Task<List<int>> ReleasesAsync(NginxLayout layout, CancellationToken cancellationToken) =>
        [.. (await Machine.ListAsync(layout.ReleasesDirectory, cancellationToken)).Select(NginxControl.ReleaseOf).OfType<int>()];

    private async Task WriteReleaseAsync(NginxRelease release, CancellationToken cancellationToken)
    {
        await Machine.CreateDirectoryAsync(release.Directory, OpenFolder, cancellationToken);
        foreach (var file in release.Files)
        {
            // nginx's workers read basic auth files at request time, not as root, so these stay
            // world-readable like the rest (they hold SHA-512 crypt hashes, never passwords).
            await Machine.WriteAsync($"{release.Directory}/{file.Path}", Encoding.UTF8.GetBytes(file.Content), Readable, cancellationToken);
        }
    }

    private Task WriteMarkerAsync(NginxLayout layout, NginxApplyMarker marker, CancellationToken cancellationToken) =>
        Machine.WriteAsync(layout.ApplyMarker, JsonSerializer.SerializeToUtf8Bytes(marker, CoreJson.Options), PrivateFile, cancellationToken);

    /// <summary>Keys are root-only (0600 in a 0700 folder): nginx's master reads them as root at load time.</summary>
    private async Task WriteCertificatesAsync(IReadOnlyList<NginxCertificateFiles> certificates, NginxLayout layout, CancellationToken cancellationToken)
    {
        if (certificates.Count == 0)
        {
            return;
        }

        await Machine.CreateDirectoryAsync(layout.CertificatesDirectory, PrivateFolder, cancellationToken);
        foreach (var files in certificates)
        {
            await Machine.CreateDirectoryAsync($"{layout.CertificatesDirectory}/{files.SiteId}", PrivateFolder, cancellationToken);
            await WriteIfChangedAsync(layout.CertificateFile(files.SiteId), files.ChainPem, cancellationToken);
            await WriteIfChangedAsync(layout.KeyFile(files.SiteId), files.KeyPem, cancellationToken);
        }
    }

    private async Task WriteIfChangedAsync(string path, string content, CancellationToken cancellationToken)
    {
        if (await Machine.ReadTextAsync(path, cancellationToken) != content)
        {
            await Machine.WriteAsync(path, Encoding.ASCII.GetBytes(content), PrivateFile, cancellationToken);
        }
    }

    /// <summary>
    /// A name is checked as written by the validator; here it is resolved the way nginx will, and
    /// every address it gives has to pass the same check an address written directly would.
    /// </summary>
    private async Task<List<NginxProblem>> CheckResolvedUpstreamsAsync(NginxConfiguration configuration, CancellationToken cancellationToken)
    {
        var problems = new List<NginxProblem>();
        foreach (var (field, host) in UpstreamHosts(configuration))
        {
            if (NginxAddresses.TryParse(host, out _))
            {
                continue;
            }

            IPAddress[] addresses;
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(_resolveTimeout);
            try
            {
                addresses = await resolver.ResolveAsync(host, timeout.Token);
            }
            catch (Exception error) when (error is System.Net.Sockets.SocketException or OperationCanceledException && !cancellationToken.IsCancellationRequested)
            {
                problems.Add(new NginxProblem(field, $"{host} does not resolve from this server, and nginx refuses to load an upstream it cannot find."));
                continue;
            }

            if (addresses.Length == 0)
            {
                problems.Add(new NginxProblem(field, $"{host} resolves to no address."));
            }

            foreach (var address in addresses)
            {
                if (UpstreamPolicy.CheckAddress(address) is { } refusal)
                {
                    problems.Add(new NginxProblem(field, $"{host} resolves to {address}, which is refused: {refusal}"));
                    break;
                }
            }
        }

        return problems;
    }

    /// <summary>Every host name nginx will resolve: URL upstreams, stream endpoints, and proxy_pass in snippets.</summary>
    private IEnumerable<(string Field, string Host)> UpstreamHosts(NginxConfiguration configuration)
    {
        foreach (var site in configuration.Sites)
        {
            if (site.Upstream is NginxUrlUpstream url && upstreams.TryParseUrl(url.Url, out var parsed, out _))
            {
                yield return ($"sites[{site.Id}].upstream", parsed.Host);
            }

            foreach (var (name, snippet) in new[] { ("serverSnippet", site.ServerSnippet), ("locationSnippet", site.LocationSnippet) })
            {
                if (string.IsNullOrWhiteSpace(snippet))
                {
                    continue;
                }

                foreach (var target in ProxyPasses(NginxConfigParser.Parse(NginxSnippet.Normalize(snippet))))
                {
                    if (upstreams.TryParseUrl(target, out var inSnippet, out _))
                    {
                        yield return ($"sites[{site.Id}].{name}", inSnippet.Host);
                    }
                }
            }
        }

        foreach (var stream in configuration.Streams)
        {
            if (stream.Upstream is NginxEndpointUpstream endpoint && upstreams.TryParseEndpoint(endpoint.Endpoint, out var parsed, out _))
            {
                yield return ($"streams[{stream.Id}].upstream", parsed.Host);
            }
        }
    }

    private static IEnumerable<string> ProxyPasses(IReadOnlyList<NginxDirective> directives)
    {
        foreach (var directive in directives)
        {
            if (directive.Name == "proxy_pass" && directive.Arguments.Count == 1)
            {
                yield return directive.Arguments[0];
            }

            if (directive.Block is { } block)
            {
                foreach (var inner in ProxyPasses(block))
                {
                    yield return inner;
                }
            }
        }
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "nginx runs release {Release}.")]
    private static partial void LogApplied(ILogger logger, int release);

    [LoggerMessage(Level = LogLevel.Warning, Message = "nginx -t refused release {Release}; the previous release stays.")]
    private static partial void LogTestRefused(ILogger logger, int release);

    [LoggerMessage(Level = LogLevel.Warning, Message = "nginx did not take release {Release} on reload; the previous release stays.")]
    private static partial void LogReloadRefused(ILogger logger, int release);

    [LoggerMessage(Level = LogLevel.Error, Message = "Reloading nginx back from release {Release} was not confirmed; check nginx's error log.")]
    private static partial void LogUndoReloadFailed(ILogger logger, int release);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Removing old nginx releases or certificates failed; they stay for now.")]
    private static partial void LogCleanupFailed(ILogger logger, Exception error);

    [LoggerMessage(Level = LogLevel.Warning, Message = "The nginx apply marker could not be read; it was removed.")]
    private static partial void LogMarkerUnreadable(ILogger logger);

    [LoggerMessage(Level = LogLevel.Information, Message = "Finished recording nginx release {Release}, which nginx already ran when the core stopped.")]
    private static partial void LogRecoveredFinished(ILogger logger, int release);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Undid nginx release {Release}, interrupted when the core stopped; back on release {Previous}.")]
    private static partial void LogRecoveredUndone(ILogger logger, int release, int? previous);

    private sealed class Lease(SemaphoreSlim gate) : IDisposable
    {
        private int _disposed;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 0)
            {
                gate.Release();
            }
        }
    }
}
