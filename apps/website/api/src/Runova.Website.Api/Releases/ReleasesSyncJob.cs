using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Runova.Website.Core.Releases;
using Runova.Website.Data;
using Sentry;

namespace Runova.Website.Api.Releases;

/// <summary>
/// Stores the latest desktop release from GitHub, with only its desktop assets. A 304 writes
/// nothing. When GitHub fails, the failure goes to Sentry and the stored release stays as it was,
/// so the endpoints keep serving it.
/// </summary>
internal sealed partial class ReleasesSyncJob(
    GitHubReleasesClient github, AppDbContext db, TimeProvider time, IHub sentry, ILogger<ReleasesSyncJob> logger)
{
    public async Task RunAsync(CancellationToken cancellationToken)
    {
        var stored = await db.Releases.OrderByDescending(r => r.FetchedAt).FirstOrDefaultAsync(cancellationToken);
        Release fetched;
        string? etag;
        try
        {
            var latest = await github.GetLatestAsync(stored?.GitHubETag, cancellationToken);
            if (latest is null)
            {
                LogNotModified(logger, stored?.TagName);
                return;
            }

            fetched = GitHubReleases.Read(latest.Json, time.GetUtcNow());
            etag = latest.ETag;
        }
        catch (Exception e) when (e is HttpRequestException or JsonException
            || (e is TaskCanceledException && !cancellationToken.IsCancellationRequested))
        {
            // A timeout is a TaskCanceledException too, but only a shutdown should stop the job quietly.
            sentry.CaptureException(e);
            LogFailed(logger, e);
            return;
        }

        var release = stored?.TagName == fetched.TagName
            ? stored
            : await db.Releases.SingleOrDefaultAsync(r => r.TagName == fetched.TagName, cancellationToken);
        if (release is null)
        {
            release = new Release();
            db.Releases.Add(release);
        }

        release.Version = fetched.Version;
        release.TagName = fetched.TagName;
        release.Name = fetched.Name;
        release.PublishedAt = fetched.PublishedAt;
        release.NotesUrl = fetched.NotesUrl;
        release.FetchedAt = fetched.FetchedAt;
        release.Assets = fetched.Assets;
        release.GitHubETag = etag;
        await db.SaveChangesAsync(cancellationToken);
        LogStored(logger, release.TagName, release.Assets.Count);
    }

    [LoggerMessage(Level = LogLevel.Debug, Message = "The latest GitHub release is still {Tag}")]
    private static partial void LogNotModified(ILogger logger, string? tag);

    [LoggerMessage(Level = LogLevel.Information, Message = "Stored GitHub release {Tag} with {Assets} desktop assets")]
    private static partial void LogStored(ILogger logger, string tag, int assets);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Could not read the latest release from GitHub; the stored one stays")]
    private static partial void LogFailed(ILogger logger, Exception exception);
}
