using Microsoft.EntityFrameworkCore;
using NpgsqlTypes;
using Runova.Website.Core.News;

namespace Runova.Website.Data.News;

/// <summary>The tables behind news: <c>NewsItems</c>, its affected technologies and the technology list.</summary>
internal static class NewsModel
{
    /// <summary>The generated full-text column over title, summary and body; <c>q</c> searches it.</summary>
    public const string SearchVector = "SearchVector";

    public static void ConfigureNews(this ModelBuilder builder)
    {
        builder.Entity<Technology>(technology =>
        {
            technology.Property(t => t.Id).ValueGeneratedNever();
            technology.Property(t => t.Slug).HasMaxLength(40);
            technology.Property(t => t.Name).HasMaxLength(80);
            // The foreign key from NewsItemTechnologies makes Slug an alternate key, which is unique.
            technology.HasData(Technologies.All);
        });

        builder.Entity<NewsItem>(item =>
        {
            item.Property(i => i.Slug).HasMaxLength(120);
            item.Property(i => i.Title).HasMaxLength(160);
            item.Property(i => i.Summary).HasMaxLength(400);
            item.Property(i => i.CvssScore).HasPrecision(3, 1);
            // No foreign key to the creator: an item outlives the user or client that wrote it.
            item.Property(i => i.CreatedByKind).HasMaxLength(16);
            item.Property(i => i.Version).IsRowVersion();
            item.HasIndex(i => i.Slug).IsUnique();
            item.HasIndex(i => new { i.Status, i.PublishedAt });
            item.HasIndex(i => i.Tags).HasMethod("gin");

            item.ComplexCollection(i => i.SourceLinks, links => links.ToJson());

            item.Property<NpgsqlTsVector>(SearchVector)
                .IsGeneratedTsVectorColumn("english", nameof(NewsItem.Title), nameof(NewsItem.Summary), nameof(NewsItem.BodyMarkdown));
            item.HasIndex(SearchVector).HasMethod("gin");

            item.OwnsMany(i => i.Technologies, technologies =>
            {
                technologies.ToTable("NewsItemTechnologies");
                technologies.WithOwner().HasForeignKey("NewsItemId");
                technologies.Property<long>("Id");
                technologies.HasKey("Id");
                technologies.Property(t => t.Technology).HasMaxLength(40);
                technologies.Property(t => t.VersionRange).HasMaxLength(100);
                technologies.Property(t => t.FixedIn).HasMaxLength(40);
                technologies.HasIndex(t => t.Technology);
                technologies.HasOne<Technology>().WithMany().HasForeignKey(t => t.Technology).HasPrincipalKey(t => t.Slug).OnDelete(DeleteBehavior.Restrict);
            });
        });
    }
}
