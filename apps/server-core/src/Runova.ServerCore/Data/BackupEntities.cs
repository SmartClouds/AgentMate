using Microsoft.EntityFrameworkCore;
using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.Data;

/// <summary>
/// The key scheduled backups are encrypted to (E28): its public half and its private half sealed with
/// the secret key, which the core never holds. One row, or none until an Owner sets a secret.
/// </summary>
internal sealed class BackupKeyRingRecord
{
    public const int SingletonId = 1;

    public int Id { get; set; } = SingletonId;

    public required string KeyId { get; set; }

    public required string PublicKey { get; set; }

    /// <summary>The <see cref="Backups.BackupKeySlot"/> as JSON.</summary>
    public required string Slot { get; set; }

    public long CreatedAt { get; set; }

    public long UpdatedAt { get; set; }
}

/// <summary>Somewhere backups go. What is not secret is plain JSON; the credentials are sealed with Data Protection.</summary>
internal sealed class BackupDestinationRecord
{
    public Guid Id { get; set; }

    public required string Name { get; set; }

    public BackupDestinationKind Kind { get; set; }

    /// <summary>The <see cref="BackupDestinationSettings"/> as JSON.</summary>
    public required string Settings { get; set; }

    /// <summary>The <see cref="BackupDestinationSecret"/> as JSON, sealed; null when it needs none.</summary>
    public string? ProtectedSecret { get; set; }

    /// <summary>The largest part the destination is sent, or null for one file (Telegram has its own cap on top).</summary>
    public long? MaxPartBytes { get; set; }

    public long CreatedAt { get; set; }

    public long UpdatedAt { get; set; }

    public long? LastTestedAt { get; set; }

    public string? LastError { get; set; }
}

/// <summary>A schedule: when (cron in a time zone), where to, and how many backups each destination keeps.</summary>
internal sealed class BackupPlanRecord
{
    public Guid Id { get; set; }

    public required string Name { get; set; }

    public bool Enabled { get; set; }

    public required string Cron { get; set; }

    public required string TimeZone { get; set; }

    public int KeepLast { get; set; }

    public int? KeepDays { get; set; }

    public long CreatedAt { get; set; }

    public long UpdatedAt { get; set; }
}

/// <summary>A destination a plan sends to. Removing the destination takes it out of every plan.</summary>
internal sealed class BackupPlanDestinationRecord
{
    public Guid PlanId { get; set; }

    public Guid DestinationId { get; set; }
}

/// <summary>One backup made: by a plan or by hand, how it went, and where it went.</summary>
internal sealed class BackupRunRecord
{
    /// <summary>Also the backup's id in every manifest.</summary>
    public Guid Id { get; set; }

    public Guid? PlanId { get; set; }

    public string? PlanName { get; set; }

    public BackupTrigger Trigger { get; set; }

    public BackupRunState State { get; set; }

    public long StartedAt { get; set; }

    public long? FinishedAt { get; set; }

    public long? SizeBytes { get; set; }

    public string? Sha256 { get; set; }

    public string? Error { get; set; }

    public string? RequestedByName { get; set; }

    /// <summary>Whether the file waits an hour on the server for the app to download, once uploaded.</summary>
    public bool KeepForDownload { get; set; }
}

/// <summary>How one destination of a run went.</summary>
internal sealed class BackupRunTargetRecord
{
    public Guid RunId { get; set; }

    public Guid DestinationId { get; set; }

    public required string DestinationName { get; set; }

    public BackupTargetState State { get; set; }

    public int Attempts { get; set; }

    public long? FinishedAt { get; set; }

    public int Pruned { get; set; }

    public string? Error { get; set; }
}

internal static class BackupModel
{
    public static void Configure(ModelBuilder builder)
    {
        builder.Entity<BackupKeyRingRecord>(ring =>
        {
            ring.HasKey(r => r.Id);
            ring.Property(r => r.Id).ValueGeneratedNever();
            ring.Property(r => r.KeyId).HasMaxLength(32);
            ring.Property(r => r.PublicKey).HasMaxLength(512);
            ring.Property(r => r.Slot).HasMaxLength(2048);
        });

        builder.Entity<BackupDestinationRecord>(destination =>
        {
            destination.HasKey(d => d.Id);
            destination.Property(d => d.Name).HasMaxLength(100);
            destination.Property(d => d.Kind).HasConversion<string>().HasMaxLength(20);
            destination.Property(d => d.Settings).HasMaxLength(8192);
            destination.Property(d => d.LastError).HasMaxLength(1000);
            destination.HasIndex(d => d.Name).IsUnique();
        });

        builder.Entity<BackupPlanRecord>(plan =>
        {
            plan.HasKey(p => p.Id);
            plan.Property(p => p.Name).HasMaxLength(100);
            plan.Property(p => p.Cron).HasMaxLength(100);
            plan.Property(p => p.TimeZone).HasMaxLength(100);
            plan.HasIndex(p => p.Name).IsUnique();
        });

        builder.Entity<BackupPlanDestinationRecord>(target =>
        {
            target.HasKey(t => new { t.PlanId, t.DestinationId });
            target.HasOne<BackupPlanRecord>().WithMany().HasForeignKey(t => t.PlanId).OnDelete(DeleteBehavior.Cascade);
            target.HasOne<BackupDestinationRecord>().WithMany().HasForeignKey(t => t.DestinationId).OnDelete(DeleteBehavior.Cascade);
        });

        // Runs keep their plan's name, so the history still reads after the plan is gone.
        builder.Entity<BackupRunRecord>(run =>
        {
            run.HasKey(r => r.Id);
            run.Property(r => r.PlanName).HasMaxLength(100);
            run.Property(r => r.Trigger).HasConversion<string>().HasMaxLength(20);
            run.Property(r => r.State).HasConversion<string>().HasMaxLength(20);
            run.Property(r => r.Sha256).HasMaxLength(64);
            run.Property(r => r.Error).HasMaxLength(1000);
            run.Property(r => r.RequestedByName).HasMaxLength(256);
            run.HasIndex(r => r.StartedAt);
            run.HasIndex(r => r.PlanId);
        });

        builder.Entity<BackupRunTargetRecord>(target =>
        {
            target.HasKey(t => new { t.RunId, t.DestinationId });
            target.Property(t => t.DestinationName).HasMaxLength(100);
            target.Property(t => t.State).HasConversion<string>().HasMaxLength(20);
            target.Property(t => t.Error).HasMaxLength(1000);
            target.HasOne<BackupRunRecord>().WithMany().HasForeignKey(t => t.RunId).OnDelete(DeleteBehavior.Cascade);
        });
    }
}
