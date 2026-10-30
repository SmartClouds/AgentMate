using Microsoft.EntityFrameworkCore;
using Runova.Website.Core.Releases;

namespace Runova.Website.Data.Releases;

/// <summary>
/// <c>Releases</c>: one row per tag GitHub has called the latest, its desktop assets in a JSON
/// column, so a sync writes a single row.
/// </summary>
internal static class ReleasesModel
{
    public static void ConfigureReleases(this ModelBuilder builder) =>
        builder.Entity<Release>(release =>
        {
            release.Property(r => r.Version).HasMaxLength(64);
            release.Property(r => r.TagName).HasMaxLength(64);
            release.Property(r => r.Name).HasMaxLength(200);
            release.Property(r => r.NotesUrl).HasMaxLength(500);
            release.Property(r => r.GitHubETag).HasMaxLength(200);
            release.Property(r => r.RowVersion).IsRowVersion();
            release.HasIndex(r => r.TagName).IsUnique();
            release.HasIndex(r => r.FetchedAt);
            release.ComplexCollection(r => r.Assets, assets => assets.ToJson());
        });
}
