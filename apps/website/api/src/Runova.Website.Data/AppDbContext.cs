using Microsoft.AspNetCore.DataProtection.EntityFrameworkCore;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;
using Runova.Website.Core.ApiClients;
using Runova.Website.Core.News;
using Runova.Website.Data.ApiClients;
using Runova.Website.Data.Audit;
using Runova.Website.Data.Identity;
using Runova.Website.Data.News;

namespace Runova.Website.Data;

/// <summary>
/// The website's PostgreSQL database. Every key is a <c>bigint</c> identity column, the Identity
/// tables' included; the resources add their sets later.
/// </summary>
public class AppDbContext(DbContextOptions<AppDbContext> options)
    : IdentityDbContext<AppUser, AppRole, long>(options), IDataProtectionKeyContext
{
    public DbSet<SetupLink> SetupLinks => Set<SetupLink>();

    public DbSet<AuditEntry> AuditEntries => Set<AuditEntry>();

    public DbSet<NewsItem> NewsItems => Set<NewsItem>();

    public DbSet<Technology> Technologies => Set<Technology>();

    public DbSet<ApiClient> ApiClients => Set<ApiClient>();

    public DbSet<SignatureNonce> SignatureNonces => Set<SignatureNonce>();

    public DbSet<IdempotencyRecord> IdempotencyRecords => Set<IdempotencyRecord>();

    /// <summary>The Data Protection key ring, shared by every API instance.</summary>
    public DbSet<DataProtectionKey> DataProtectionKeys => Set<DataProtectionKey>();

    protected override void OnModelCreating(ModelBuilder builder)
    {
        base.OnModelCreating(builder);

        builder.Entity<AppUser>(user =>
        {
            user.Property(u => u.DisplayName).HasMaxLength(100);
            user.Property(u => u.Version).IsRowVersion();
        });

        builder.Entity<SetupLink>(link =>
        {
            link.Property(l => l.Purpose).HasMaxLength(20);
            link.HasIndex(l => l.TokenHash).IsUnique();
            link.HasIndex(l => l.UserId);
            link.HasIndex(l => l.ExpiresAt);
            link.HasOne<AppUser>().WithMany().HasForeignKey(l => l.UserId).OnDelete(DeleteBehavior.Cascade);
        });

        // No foreign keys: an entry outlives the user or client it names.
        builder.Entity<AuditEntry>(entry =>
        {
            entry.Property(e => e.ActorKind).HasMaxLength(16);
            entry.Property(e => e.Action).HasMaxLength(64);
            entry.Property(e => e.TargetType).HasMaxLength(32);
            entry.Property(e => e.TargetId).HasMaxLength(64);
            entry.Property(e => e.Ip).HasMaxLength(45);
            entry.Property(e => e.Changes).HasColumnType("jsonb");
            entry.HasIndex(e => e.At);
            entry.HasIndex(e => new { e.TargetType, e.TargetId });
            entry.HasIndex(e => new { e.ActorKind, e.ActorId });
        });

        builder.ConfigureNews();
        builder.ConfigureApiClients();

        // Identity gives claims an int key, and Data Protection its keys; widen them so every key in the database is bigint.
        builder.Entity<IdentityUserClaim<long>>().Property(c => c.Id).HasConversion<long>();
        builder.Entity<IdentityRoleClaim<long>>().Property(c => c.Id).HasConversion<long>();
        builder.Entity<DataProtectionKey>().Property(k => k.Id).HasConversion<long>();

        // Fixed ids and stamps, so the seed does not change from one migration to the next.
        builder.Entity<AppRole>().HasData(
            new AppRole { Id = 1, Name = Core.Identity.Roles.Admin, NormalizedName = "ADMIN", ConcurrencyStamp = "8f0d6b52-6b1e-4c1f-9a51-3c1d2a0e7a01" },
            new AppRole { Id = 2, Name = Core.Identity.Roles.Editor, NormalizedName = "EDITOR", ConcurrencyStamp = "0e5c3f7a-2d84-4b6e-8c3a-9b7f1e2d4c02" });
    }
}
