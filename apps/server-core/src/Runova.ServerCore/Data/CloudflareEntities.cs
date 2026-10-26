using Microsoft.EntityFrameworkCore;

namespace Runova.ServerCore.Data;

// Cloudflare on the server (E14): DNS tokens for DNS-01, keys waiting for an Origin CA
// certificate, and the origin lock with the ranges it was built from.

/// <summary>A zone-scoped DNS token, sealed with Data Protection. One per zone.</summary>
internal sealed class DnsCredential
{
    /// <summary>The zone's name, lowercase ASCII (example.com).</summary>
    public required string Zone { get; set; }

    public required string ZoneId { get; set; }

    public required string Provider { get; set; }

    public required string ProtectedToken { get; set; }

    public string? TokenId { get; set; }

    public long CreatedAt { get; set; }

    public long UpdatedAt { get; set; }

    public string? CreatedBy { get; set; }

    public long? LastUsedAt { get; set; }

    public string? LastError { get; set; }
}

/// <summary>The key made for a site's Origin CA certificate, until the certificate comes back.</summary>
internal sealed class OriginCertificateKey
{
    public required string SiteId { get; set; }

    public required string ProtectedKey { get; set; }

    /// <summary>The names asked for, as a JSON array.</summary>
    public required string Hostnames { get; set; }

    public long CreatedAt { get; set; }
}

/// <summary>The origin lock: one row, made on first use.</summary>
internal sealed class OriginLockSetting
{
    public const int SingletonId = 1;

    public int Id { get; set; } = SingletonId;

    public bool Enabled { get; set; }

    public bool AuthenticatedOriginPulls { get; set; }

    /// <summary>JSON arrays of CIDR networks.</summary>
    public string Ipv4 { get; set; } = "[]";

    public string Ipv6 { get; set; } = "[]";

    public long? RangesFetchedAt { get; set; }

    public long? LastRefreshAt { get; set; }

    public string? LastRefreshError { get; set; }

    /// <summary>The firewall change that last turned the lock on or off, or brought it up to date.</summary>
    public Guid? ChangeSetId { get; set; }

    public long UpdatedAt { get; set; }
}

internal static class CloudflareModel
{
    public static void Configure(ModelBuilder builder)
    {
        builder.Entity<DnsCredential>(credential =>
        {
            credential.HasKey(c => c.Zone);
            credential.Property(c => c.Zone).HasMaxLength(253);
            credential.Property(c => c.ZoneId).HasMaxLength(64);
            credential.Property(c => c.Provider).HasMaxLength(40);
            credential.Property(c => c.TokenId).HasMaxLength(64);
            credential.Property(c => c.CreatedBy).HasMaxLength(256);
            credential.Property(c => c.LastError).HasMaxLength(1000);
        });

        builder.Entity<OriginCertificateKey>(key =>
        {
            key.HasKey(k => k.SiteId);
            key.Property(k => k.SiteId).HasMaxLength(63);
        });

        builder.Entity<OriginLockSetting>(setting =>
        {
            setting.HasKey(s => s.Id);
            setting.Property(s => s.Id).ValueGeneratedNever();
            setting.Property(s => s.LastRefreshError).HasMaxLength(1000);
        });
    }
}
