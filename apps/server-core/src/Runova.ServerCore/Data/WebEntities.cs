using Microsoft.EntityFrameworkCore;

namespace Runova.ServerCore.Data;

// Websites, stream proxies and certificates (E10, E11). The database is the source of truth;
// nginx's files are rendered from it on every apply.

/// <summary>A website as saved. Its settings are the app's SiteSettings as JSON, without passwords.</summary>
internal sealed class Site
{
    public required string Id { get; set; }

    public required string Settings { get; set; }

    /// <summary>Basic auth users and their SHA-512 crypt hashes, as a JSON object.</summary>
    public string? BasicAuthHashes { get; set; }

    public string? ServerSnippet { get; set; }

    public string? LocationSnippet { get; set; }

    public long CreatedAt { get; set; }

    public long UpdatedAt { get; set; }

    /// <summary>The fingerprint of what nginx runs for this site; differs from the saved one while changes wait.</summary>
    public string? AppliedFingerprint { get; set; }
}

/// <summary>One domain of one site. The key makes a domain belong to one site only.</summary>
internal sealed class SiteDomain
{
    public required string Domain { get; set; }

    public required string SiteId { get; set; }

    public int Position { get; set; }
}

internal sealed class StreamProxy
{
    public required string Id { get; set; }

    public required string Settings { get; set; }

    public long CreatedAt { get; set; }

    public long UpdatedAt { get; set; }

    public string? AppliedFingerprint { get; set; }
}

/// <summary>Each release nginx ran, newest last: what was applied, when and by whom.</summary>
internal sealed class NginxReleaseRecord
{
    public long Id { get; set; }

    public int Release { get; set; }

    public required string Hash { get; set; }

    public long AppliedAt { get; set; }

    public Guid? AppliedBy { get; set; }

    public string? AppliedByName { get; set; }
}

/// <summary>
/// A site's certificate. The private key is sealed with Data Protection; nginx gets a root-only
/// copy on every apply. Renewal state lives here too, so it survives restarts.
/// </summary>
internal sealed class SiteCertificate
{
    public required string SiteId { get; set; }

    /// <summary>"acme" or "uploaded".</summary>
    public required string Source { get; set; }

    /// <summary>The ACME directory that issued it; null for an uploaded certificate.</summary>
    public string? DirectoryUrl { get; set; }

    public required string Domains { get; set; }

    public required string KeyType { get; set; }

    public required string ChainPem { get; set; }

    public required string ProtectedKey { get; set; }

    public string? CertificateId { get; set; }

    public required string Issuer { get; set; }

    public long NotBefore { get; set; }

    public long NotAfter { get; set; }

    public long IssuedAt { get; set; }

    public string? Replaced { get; set; }

    public string? PreferredChain { get; set; }

    public long? RevokedAt { get; set; }

    public bool AutoRenew { get; set; }

    /// <summary>When the renewal service plans to renew, picked once per ARI window.</summary>
    public long? RenewAt { get; set; }

    public long? WindowStart { get; set; }

    public long? WindowEnd { get; set; }

    public string? ExplanationUrl { get; set; }

    /// <summary>When the CA's renewal information should be asked for again.</summary>
    public long? NextCheckAt { get; set; }

    public int FailedAttempts { get; set; }

    public long? NextAttemptAt { get; set; }

    public long? LastAttemptAt { get; set; }

    public string? LastError { get; set; }

    public Guid? LastJobId { get; set; }
}

/// <summary>An ACME account, one per CA directory, its key sealed with Data Protection.</summary>
internal sealed class AcmeAccountRecord
{
    public long Id { get; set; }

    public required string DirectoryUrl { get; set; }

    public required string Url { get; set; }

    public required string ProtectedKey { get; set; }

    public required string Status { get; set; }

    public required string Contact { get; set; }

    public long CreatedAt { get; set; }
}

internal static class WebModel
{
    public static void Configure(ModelBuilder builder)
    {
        builder.Entity<Site>(site =>
        {
            site.HasKey(s => s.Id);
            site.Property(s => s.Id).HasMaxLength(63);
        });

        builder.Entity<SiteDomain>(domain =>
        {
            domain.HasKey(d => d.Domain);
            domain.Property(d => d.Domain).HasMaxLength(253);
            domain.HasIndex(d => d.SiteId);
            domain.HasOne<Site>().WithMany().HasForeignKey(d => d.SiteId).OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<StreamProxy>(proxy =>
        {
            proxy.HasKey(p => p.Id);
            proxy.Property(p => p.Id).HasMaxLength(63);
        });

        builder.Entity<NginxReleaseRecord>(release =>
        {
            release.HasKey(r => r.Id);
            release.Property(r => r.Hash).HasMaxLength(64);
            release.Property(r => r.AppliedByName).HasMaxLength(256);
        });

        builder.Entity<SiteCertificate>(certificate =>
        {
            certificate.ToTable("Certificates");
            certificate.HasKey(c => c.SiteId);
            certificate.Property(c => c.Source).HasMaxLength(20);
            certificate.Property(c => c.KeyType).HasMaxLength(20);
            certificate.HasOne<Site>().WithOne().HasForeignKey<SiteCertificate>(c => c.SiteId).OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<AcmeAccountRecord>(account =>
        {
            account.ToTable("AcmeAccounts");
            account.HasKey(a => a.Id);
            account.HasIndex(a => a.DirectoryUrl).IsUnique();
        });
    }
}
