using System.Text;
using System.Text.Json;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Nginx;
using Runova.ServerCore.Platform;

namespace Runova.ServerCore.Web;

/// <summary>A site's custom snippets, as stored.</summary>
internal sealed record SiteSnippetRow(string SiteId, string? ServerSnippet, string? LocationSnippet);

/// <summary>What the nginx move needs from the saved sites: their snippets, and an apply plan for a layout.</summary>
internal interface INginxMoveData
{
    Task<IReadOnlyList<SiteSnippetRow>> SnippetsAsync(CancellationToken cancellationToken);

    Task SetSnippetsAsync(IReadOnlyList<SiteSnippetRow> snippets, CancellationToken cancellationToken);

    Task<(NginxApplyPlan Plan, NginxAppliedState State)> PlanAsync(NginxLayout layout, CancellationToken cancellationToken);

    Task RecordAsync(int release, NginxAppliedState state, CancellationToken cancellationToken);
}

/// <summary>
/// What the nginx move changed, written before it changes anything, so a core that stops halfway
/// puts it all back on its next start. Phase "moving" until nginx runs the new names, then
/// "applied" while the old caches go.
/// </summary>
internal sealed record NginxMoveJournal(
    string Phase,
    string ConfPath,
    string? OriginalConf,
    int? Release,
    IReadOnlyList<string> Logs,
    IReadOnlyList<SiteSnippetRow> Snippets)
{
    public const string Moving = "moving";
    public const string Applied = "applied";
}

/// <summary>
/// Moves nginx on a server set up before the rename to the new names: the configuration folder
/// (releases, current, certificates), the web root (ACME and site folders), the sites' log files
/// and, by rendering every site again, the cache folders, zones and the upgrade map. Snippet
/// roots in the database follow the site folders, and nginx.conf's include lines are rewired. Like
/// the setup, it backs up first and checks with nginx -t and a confirmed reload; on any failure
/// everything goes back and nginx runs as it did, under the old names.
/// </summary>
/// <remarks>
/// The old configuration folder and web root stay behind as links to the new ones: deploy targets
/// the app saved (a files site in /var/www/...), hand-written nginx files that use the core's
/// certificates, and scripts on the server may name them. Call while holding the applier's lock.
/// </remarks>
internal sealed partial class NginxNameMove(
    NginxControl control,
    NginxApplier applier,
    NginxSeLinux seLinux,
    INginxMoveData data,
    OsFamily family,
    string journalPath,
    ILogger<NginxNameMove> logger)
{
    private static readonly JsonSerializerOptions _json = new(CoreJson.Options) { WriteIndented = true };

    private const UnixFileMode PrivateFile = UnixFileMode.UserRead | UnixFileMode.UserWrite;
    private const UnixFileMode Readable = PrivateFile | UnixFileMode.GroupRead | UnixFileMode.OtherRead;

    private INginxMachine Machine => control.Machine;

    /// <summary>The move, or what is in its way. Puts back a move a previous core left halfway first.</summary>
    public async Task<NameMoveStatus> RunAsync(CancellationToken cancellationToken)
    {
        var first = await control.InspectAsync(NginxControl.LayoutFor(family, NginxInspection.Missing(false, true), legacyNames: true), cancellationToken);
        var from = NginxControl.LayoutFor(family, first, legacyNames: true);
        var to = NginxControl.LayoutFor(family, first, legacyNames: false);

        if (await ReadJournalAsync(cancellationToken) is { } left)
        {
            if (left.Phase == NginxMoveJournal.Applied)
            {
                await FinishAsync(from, cancellationToken);
                return new NameMoveStatus(NameMovePhase.Done);
            }

            LogPuttingBack(logger);
            await PutBackAsync(left, from, to, cancellationToken);
        }

        if (!await IsFolderAsync(from.ConfigRoot, cancellationToken))
        {
            return new NameMoveStatus(await Machine.ReadLinkAsync(from.ConfigRoot, cancellationToken) is null ? NameMovePhase.NotNeeded : NameMovePhase.Done);
        }

        foreach (var path in new[] { to.ConfigRoot, to.WebRoot })
        {
            if (await Machine.ExistsAsync(path, cancellationToken))
            {
                return new NameMoveStatus(NameMovePhase.Failed, $"{path} is there already, so nginx keeps its old names.");
            }
        }

        var original = first.Installed ? await Machine.ReadTextAsync(first.ConfPath, cancellationToken) : null;
        var oldSites = from.SitesRoot + "/";
        var snippets = (await data.SnippetsAsync(cancellationToken))
            .Where(row => (row.ServerSnippet?.Contains(oldSites, StringComparison.Ordinal) ?? false)
                || (row.LocationSnippet?.Contains(oldSites, StringComparison.Ordinal) ?? false))
            .ToList();
        var logs = (await Machine.ListAsync(from.LogDirectory, cancellationToken))
            .Where(name => name.StartsWith(from.NamePrefix + "-", StringComparison.Ordinal))
            .ToList();
        var journal = new NginxMoveJournal(NginxMoveJournal.Moving, first.ConfPath, original, first.CurrentRelease, logs, snippets);
        await WriteJournalAsync(journal, cancellationToken);
        try
        {
            await MoveAndLinkAsync(from.ConfigRoot, to.ConfigRoot, cancellationToken);
            if (await IsFolderAsync(from.WebRoot, cancellationToken))
            {
                await MoveAndLinkAsync(from.WebRoot, to.WebRoot, cancellationToken);
            }

            foreach (var name in logs)
            {
                var renamed = to.NamePrefix + name[from.NamePrefix.Length..];
                if (!await Machine.ExistsAsync($"{to.LogDirectory}/{renamed}", cancellationToken))
                {
                    await Machine.MoveAsync($"{from.LogDirectory}/{name}", $"{to.LogDirectory}/{renamed}", cancellationToken);
                }
            }

            await data.SetSnippetsAsync([.. snippets.Select(row => row with
            {
                ServerSnippet = row.ServerSnippet?.Replace(oldSites, to.SitesRoot + "/", StringComparison.Ordinal),
                LocationSnippet = row.LocationSnippet?.Replace(oldSites, to.SitesRoot + "/", StringComparison.Ordinal),
            })], cancellationToken);

            if (original is not null && first.HttpWired)
            {
                await ApplyUnderNewNamesAsync(original, first, to, cancellationToken);
            }

            await WriteJournalAsync(journal with { Phase = NginxMoveJournal.Applied }, cancellationToken);
            await FinishAsync(from, cancellationToken);
            LogMoved(logger);
            return new NameMoveStatus(NameMovePhase.Done);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or NginxMoveException or InvalidOperationException)
        {
            LogFailed(logger, error);
            await PutBackAsync(journal, from, to, CancellationToken.None);
            return new NameMoveStatus(NameMovePhase.Failed, error.Message);
        }
    }

    private async Task ApplyUnderNewNamesAsync(string original, NginxInspection first, NginxLayout to, CancellationToken cancellationToken)
    {
        var from = NginxControl.LayoutFor(family, first, legacyNames: true);
        await Machine.WriteAsync(first.ConfPath, Encoding.UTF8.GetBytes(NginxConfWiring.Rewire(original, from, to)), Readable, cancellationToken);
        if (first.SeLinuxEnabled)
        {
            foreach (var warning in await seLinux.PrepareAsync(to, cancellationToken))
            {
                LogSeLinux(logger, warning);
            }
        }

        var inspection = await control.InspectAsync(to, cancellationToken);
        var (plan, state) = await data.PlanAsync(to, cancellationToken);
        var outcome = await applier.ApplyAsync(plan with { State = state }, inspection, to, cancellationToken);
        if (!outcome.Applied)
        {
            var problems = string.Join(" ", outcome.Problems.Select(problem => problem.Message));
            throw new NginxMoveException(
                $"nginx did not take its configuration under the new names: {outcome.Error ?? (problems.Length > 0 ? problems : "nginx -t or the reload failed")}");
        }

        await data.RecordAsync(outcome.Release!.Value, state, cancellationToken);
        await applier.CompleteAsync(plan, to, outcome.Release.Value, cancellationToken);
    }

    /// <summary>
    /// Undoes whatever of the move happened, in reverse, each part only when it is still to undo:
    /// nginx.conf, the snippets, the log names, the links and folders, the current release. Then
    /// nginx is checked and reloaded so it runs the old names again.
    /// </summary>
    private async Task PutBackAsync(NginxMoveJournal journal, NginxLayout from, NginxLayout to, CancellationToken cancellationToken)
    {
        if (journal.OriginalConf is { } original && await Machine.ReadTextAsync(journal.ConfPath, cancellationToken) != original)
        {
            await Machine.WriteAsync(journal.ConfPath, Encoding.UTF8.GetBytes(original), Readable, cancellationToken);
        }

        await data.SetSnippetsAsync(journal.Snippets, cancellationToken);
        foreach (var name in journal.Logs)
        {
            var renamed = $"{to.LogDirectory}/{to.NamePrefix}{name[from.NamePrefix.Length..]}";
            if (await Machine.ExistsAsync(renamed, cancellationToken) && !await Machine.ExistsAsync($"{from.LogDirectory}/{name}", cancellationToken))
            {
                await Machine.MoveAsync(renamed, $"{from.LogDirectory}/{name}", cancellationToken);
            }
        }

        foreach (var (old, moved) in new[] { (from.WebRoot, to.WebRoot), (from.ConfigRoot, to.ConfigRoot) })
        {
            if (await Machine.ReadLinkAsync(old, cancellationToken) is not null)
            {
                await Machine.DeleteAsync(old, cancellationToken);
            }

            if (await IsFolderAsync(moved, cancellationToken) && !await Machine.ExistsAsync(old, cancellationToken))
            {
                await Machine.MoveAsync(moved, old, cancellationToken);
            }
        }

        if (journal.Release is { } release)
        {
            await Machine.ReplaceLinkAsync(from.CurrentLink, "releases/" + release.ToString(System.Globalization.CultureInfo.InvariantCulture), cancellationToken);
        }

        var inspection = await control.InspectAsync(from, cancellationToken);
        if (inspection.Installed)
        {
            // An apply the move left halfway lives in the old folder now; it goes back too.
            await applier.RecoverAsync(from, inspection, cancellationToken);
            if (inspection.Running && (await control.TestAsync(cancellationToken)).Succeeded)
            {
                var reload = await control.ReloadAsync(inspection, from, cancellationToken);
                if (!reload.Confirmed)
                {
                    LogReloadFailed(logger, reload.Error);
                }
            }
        }

        await Machine.DeleteAsync(journalPath, cancellationToken);
    }

    /// <summary>Once nginx runs the new names: the old cache folders (only cache) go, and so does the journal.</summary>
    private async Task FinishAsync(NginxLayout from, CancellationToken cancellationToken)
    {
        foreach (var name in await Machine.ListAsync(from.CacheRoot, cancellationToken))
        {
            if (name.StartsWith(from.NamePrefix + "-", StringComparison.Ordinal))
            {
                await Machine.DeleteAsync($"{from.CacheRoot}/{name}", cancellationToken);
            }
        }

        await Machine.DeleteAsync(journalPath, cancellationToken);
    }

    private async Task MoveAndLinkAsync(string old, string moved, CancellationToken cancellationToken)
    {
        await Machine.MoveAsync(old, moved, cancellationToken);
        await Machine.ReplaceLinkAsync(old, moved, cancellationToken);
    }

    private async Task<bool> IsFolderAsync(string path, CancellationToken cancellationToken) =>
        await Machine.ExistsAsync(path, cancellationToken) && await Machine.ReadLinkAsync(path, cancellationToken) is null;

    private async Task<NginxMoveJournal?> ReadJournalAsync(CancellationToken cancellationToken)
    {
        var text = await Machine.ReadTextAsync(journalPath, cancellationToken);
        try
        {
            return text is null ? null : JsonSerializer.Deserialize<NginxMoveJournal>(text, _json);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private Task WriteJournalAsync(NginxMoveJournal journal, CancellationToken cancellationToken) =>
        Machine.WriteAsync(journalPath, JsonSerializer.SerializeToUtf8Bytes(journal, _json), PrivateFile, cancellationToken);

    [LoggerMessage(Level = LogLevel.Information, Message = "nginx now runs under the Runova names.")]
    private static partial void LogMoved(ILogger logger);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Moving nginx to the Runova names failed; putting everything back.")]
    private static partial void LogFailed(ILogger logger, Exception error);

    [LoggerMessage(Level = LogLevel.Warning, Message = "A previous core left the nginx move halfway; putting it back first.")]
    private static partial void LogPuttingBack(ILogger logger);

    [LoggerMessage(Level = LogLevel.Warning, Message = "{Warning}")]
    private static partial void LogSeLinux(ILogger logger, string warning);

    [LoggerMessage(Level = LogLevel.Error, Message = "nginx did not take the old names back on reload: {Error}")]
    private static partial void LogReloadFailed(ILogger logger, string error);
}

/// <summary>The nginx move could not go on; everything it did is put back.</summary>
internal sealed class NginxMoveException(string message) : Exception(message);
