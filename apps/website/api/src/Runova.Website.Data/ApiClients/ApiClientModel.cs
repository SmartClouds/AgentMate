using Microsoft.EntityFrameworkCore;
using Runova.Website.Core.ApiClients;

namespace Runova.Website.Data.ApiClients;

/// <summary>The tables behind API clients and signed requests.</summary>
internal static class ApiClientModel
{
    public static void ConfigureApiClients(this ModelBuilder builder)
    {
        builder.Entity<ApiClient>(client =>
        {
            client.Property(c => c.Name).HasMaxLength(100);
            client.HasIndex(c => c.Name).IsUnique();
            client.Property(c => c.Version).IsRowVersion();

            client.OwnsMany(c => c.Keys, keys =>
            {
                keys.ToTable("ApiClientKeys");
                keys.WithOwner().HasForeignKey("ApiClientId");
                keys.Property<long>("Id");
                keys.HasKey("Id");
                keys.Property(k => k.KeyId).HasMaxLength(19);
                keys.HasIndex(k => k.KeyId).IsUnique();
            });
        });

        builder.Entity<SignatureNonce>(nonce =>
        {
            nonce.Property(n => n.KeyId).HasMaxLength(19);
            nonce.Property(n => n.Nonce).HasMaxLength(64);
            nonce.HasIndex(n => new { n.KeyId, n.Nonce }).IsUnique();
            nonce.HasIndex(n => n.SeenAt);
        });

        builder.Entity<IdempotencyRecord>(record =>
        {
            record.Property(r => r.CallerKind).HasMaxLength(16);
            record.Property(r => r.Key).HasMaxLength(255);
            record.Property(r => r.ContentType).HasMaxLength(100);
            record.Property(r => r.Location).HasMaxLength(200);
            record.Property(r => r.ETag).HasMaxLength(40);
            record.HasIndex(r => new { r.CallerKind, r.CallerId, r.Key }).IsUnique();
            record.HasIndex(r => r.CreatedAt);
        });
    }
}
