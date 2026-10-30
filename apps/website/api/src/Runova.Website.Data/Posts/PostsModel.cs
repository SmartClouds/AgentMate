using Microsoft.EntityFrameworkCore;
using NpgsqlTypes;
using Runova.Website.Core.Media;
using Runova.Website.Core.Posts;

namespace Runova.Website.Data.Posts;

/// <summary>The tables behind the blog: <c>Posts</c>, <c>Tags</c>, the <c>PostTags</c> between them, and <c>Media</c>.</summary>
internal static class PostsModel
{
    /// <summary>The generated full-text column over title, excerpt and body; <c>q</c> searches it.</summary>
    public const string SearchVector = "SearchVector";

    public static void ConfigurePosts(this ModelBuilder builder)
    {
        builder.Entity<MediaFile>(file =>
        {
            file.ToTable("Media");
            file.Property(f => f.Path).HasMaxLength(80);
            file.Property(f => f.ContentType).HasMaxLength(20);
            file.Property(f => f.Alt).HasMaxLength(200);
            file.Property(f => f.CreatedByKind).HasMaxLength(16);
            file.HasIndex(f => f.Path).IsUnique();
            file.HasIndex(f => f.CreatedAt);
        });

        builder.Entity<Tag>(tag =>
        {
            tag.Property(t => t.Slug).HasMaxLength(40);
            tag.Property(t => t.Name).HasMaxLength(40);
            tag.HasIndex(t => t.Slug).IsUnique();
        });

        builder.Entity<Post>(post =>
        {
            post.Property(p => p.Slug).HasMaxLength(120);
            post.Property(p => p.Title).HasMaxLength(160);
            post.Property(p => p.Excerpt).HasMaxLength(300);
            post.Property(p => p.AuthorName).HasMaxLength(100);
            // No foreign key to the creator: a post outlives the user or client that wrote it.
            post.Property(p => p.CreatedByKind).HasMaxLength(16);
            post.Property(p => p.Version).IsRowVersion();
            post.HasIndex(p => p.Slug).IsUnique();
            post.HasIndex(p => new { p.Status, p.PublishedAt });

            // A cover in use can not be deleted from under its post.
            post.HasOne(p => p.CoverMedia).WithMany().HasForeignKey(p => p.CoverMediaId).OnDelete(DeleteBehavior.Restrict);
            post.HasMany(p => p.Tags).WithMany(t => t.Posts).UsingEntity("PostTags");

            post.Property<NpgsqlTsVector>(SearchVector)
                .IsGeneratedTsVectorColumn("english", nameof(Post.Title), nameof(Post.Excerpt), nameof(Post.BodyMarkdown));
            post.HasIndex(SearchVector).HasMethod("gin");
        });
    }
}
