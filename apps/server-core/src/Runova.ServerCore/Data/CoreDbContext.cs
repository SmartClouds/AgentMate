using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace Runova.ServerCore.Data;

/// <summary>
/// The core's own database: Identity's tables plus devices, sessions, the audit trail, jobs, alerts,
/// downsampled metrics and firewall change sets.
/// </summary>
internal sealed class CoreDbContext(DbContextOptions<CoreDbContext> options)
    : IdentityDbContext<CoreUser, CoreRole, Guid>(options)
{
    public DbSet<Device> Devices => Set<Device>();

    public DbSet<DeviceSession> DeviceSessions => Set<DeviceSession>();

    public DbSet<EnrollmentCode> EnrollmentCodes => Set<EnrollmentCode>();

    public DbSet<AuditEvent> AuditEvents => Set<AuditEvent>();

    public DbSet<AuditAnchor> AuditAnchors => Set<AuditAnchor>();

    public DbSet<Job> Jobs => Set<Job>();

    public DbSet<Alert> Alerts => Set<Alert>();

    public DbSet<MetricSample> MetricSamples => Set<MetricSample>();

    public DbSet<FirewallChangeSet> FirewallChangeSets => Set<FirewallChangeSet>();

    // Websites and certificates (E10, E11).
    public DbSet<Site> Sites => Set<Site>();

    public DbSet<SiteDomain> SiteDomains => Set<SiteDomain>();

    public DbSet<StreamProxy> StreamProxies => Set<StreamProxy>();

    public DbSet<NginxReleaseRecord> NginxReleases => Set<NginxReleaseRecord>();

    public DbSet<SiteCertificate> Certificates => Set<SiteCertificate>();

    public DbSet<AcmeAccountRecord> AcmeAccounts => Set<AcmeAccountRecord>();

    // Compose stacks (E07).
    public DbSet<StackRecord> Stacks => Set<StackRecord>();

    public DbSet<StackRevisionRecord> StackRevisions => Set<StackRevisionRecord>();

    // Private registries (E08).
    public DbSet<RegistryCredentialRecord> RegistryCredentials => Set<RegistryCredentialRecord>();

    // Cloudflare (E14).
    public DbSet<DnsCredential> DnsCredentials => Set<DnsCredential>();

    public DbSet<OriginCertificateKey> OriginCertificateKeys => Set<OriginCertificateKey>();

    public DbSet<OriginLockSetting> OriginLock => Set<OriginLockSetting>();

    // Server backups (E28).
    public DbSet<BackupKeyRingRecord> BackupKeyRing => Set<BackupKeyRingRecord>();

    public DbSet<BackupDestinationRecord> BackupDestinations => Set<BackupDestinationRecord>();

    public DbSet<BackupPlanRecord> BackupPlans => Set<BackupPlanRecord>();

    public DbSet<BackupPlanDestinationRecord> BackupPlanDestinations => Set<BackupPlanDestinationRecord>();

    public DbSet<BackupRunRecord> BackupRuns => Set<BackupRunRecord>();

    public DbSet<BackupRunTargetRecord> BackupRunTargets => Set<BackupRunTargetRecord>();

    protected override void OnModelCreating(ModelBuilder builder)
    {
        base.OnModelCreating(builder);

        builder.Entity<Device>(device =>
        {
            device.HasKey(d => d.Id);
            device.Property(d => d.Name).HasMaxLength(100);
            device.HasIndex(d => d.UserId);
            device.HasOne<CoreUser>().WithMany().HasForeignKey(d => d.UserId).OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<DeviceSession>(session =>
        {
            session.HasKey(s => s.Id);
            session.HasIndex(s => s.DeviceId);
            session.HasOne<Device>().WithMany().HasForeignKey(s => s.DeviceId).OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<EnrollmentCode>(code =>
        {
            code.HasKey(c => c.Id);
            code.HasIndex(c => c.CodeHash).IsUnique();
            code.HasOne<CoreUser>().WithMany().HasForeignKey(c => c.UserId).OnDelete(DeleteBehavior.Cascade);
        });

        builder.Entity<AuditEvent>(audit =>
        {
            // Ids are assigned by the appender while it holds the write lock, so the chain has no gaps.
            audit.HasKey(a => a.Id);
            audit.Property(a => a.Id).ValueGeneratedNever();
            audit.Property(a => a.Action).HasMaxLength(100);
            audit.HasIndex(a => a.At);
        });

        builder.Entity<AuditAnchor>(anchor =>
        {
            anchor.HasKey(a => a.Id);
            anchor.Property(a => a.Id).ValueGeneratedNever();
        });

        // Enums are stored by name, so the file stays readable and a reordered enum changes nothing.
        builder.Entity<Job>(job =>
        {
            job.HasKey(j => j.Id);
            job.Property(j => j.Kind).HasConversion<string>().HasMaxLength(40);
            job.Property(j => j.State).HasConversion<string>().HasMaxLength(20);
            job.Property(j => j.Title).HasMaxLength(200);
            job.Property(j => j.Resource).HasMaxLength(100);
            job.Property(j => j.RequestedByName).HasMaxLength(256);
            job.HasIndex(j => j.CreatedAt);
            job.HasIndex(j => j.State);
        });

        builder.Entity<Alert>(alert =>
        {
            alert.HasKey(a => a.Id);
            alert.Property(a => a.Kind).HasConversion<string>().HasMaxLength(40);
            alert.Property(a => a.Severity).HasConversion<string>().HasMaxLength(20);
            alert.Property(a => a.Resource).HasMaxLength(200);
            alert.Property(a => a.Message).HasMaxLength(1000);
            alert.Property(a => a.AcknowledgedByName).HasMaxLength(256);
            alert.HasIndex(a => a.Revision).IsUnique();
            alert.HasIndex(a => new { a.Kind, a.Resource, a.ResolvedAt });
        });

        builder.Entity<MetricSample>(sample =>
        {
            sample.HasKey(s => new { s.Resolution, s.At });
        });

        builder.Entity<FirewallChangeSet>(change =>
        {
            change.HasKey(c => c.Id);
            change.Property(c => c.Backend).HasConversion<string>().HasMaxLength(20);
            change.Property(c => c.State).HasConversion<string>().HasMaxLength(30);
            change.Property(c => c.RolledBackBy).HasConversion<string>().HasMaxLength(20);
            change.Property(c => c.Summary).HasMaxLength(2000);
            change.Property(c => c.AppliedOver).HasMaxLength(200);
            change.Property(c => c.AppliedFrom).HasMaxLength(64);
            change.Property(c => c.RequestedByName).HasMaxLength(256);
            change.Property(c => c.Error).HasMaxLength(1000);
            change.HasIndex(c => c.CreatedAt);
            change.HasIndex(c => c.State);
        });

        WebModel.Configure(builder);
        StackModel.Configure(builder);
        RegistryModel.Configure(builder);
        CloudflareModel.Configure(builder);
        BackupModel.Configure(builder);
    }
}

/// <summary>For `dotnet ef`: a context on a throwaway file, since the real path comes from configuration.</summary>
internal sealed class DesignTimeCoreDbContextFactory : IDesignTimeDbContextFactory<CoreDbContext>
{
    public CoreDbContext CreateDbContext(string[] args) => new(CoreDatabase.Options("design-time.db"));
}
