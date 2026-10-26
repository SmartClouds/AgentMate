using Microsoft.EntityFrameworkCore;

namespace Runova.ServerCore.Data;

// Compose stacks (E07). The rows say what each revision is and how its deploy went; the files
// themselves live under <data>/stacks, and env values only ever in the revision's .env (0600).

/// <summary>A named compose project, shown in the app as an App.</summary>
internal sealed class StackRecord
{
    public Guid Id { get; set; }

    /// <summary>The compose project name: lowercase letters, digits, dashes and underscores.</summary>
    public required string Name { get; set; }

    public string? Description { get; set; }

    public string? ProjectId { get; set; }

    public string? ProjectName { get; set; }

    public string? ComposePath { get; set; }

    public string? EnvironmentId { get; set; }

    public string? EnvironmentName { get; set; }

    public long CreatedAt { get; set; }

    public long UpdatedAt { get; set; }

    /// <summary>The revision running now, once one deployed.</summary>
    public int? LiveRevision { get; set; }

    /// <summary>The highest revision number given out, so a number is never reused.</summary>
    public int LastRevision { get; set; }
}

/// <summary>
/// One upload of a stack's files. The list columns are JSON arrays: env keys (never values),
/// services, proxied services, the core's findings, acknowledged finding ids, port bindings
/// after the loopback override, and the deploy's steps.
/// </summary>
internal sealed class StackRevisionRecord
{
    public Guid StackId { get; set; }

    public int Number { get; set; }

    /// <summary>A StackRevisionState name.</summary>
    public required string State { get; set; }

    public long CreatedAt { get; set; }

    public string? CreatedBy { get; set; }

    public required string ComposeSha256 { get; set; }

    public string EnvKeys { get; set; } = "[]";

    public string Services { get; set; } = "[]";

    public string ProxiedServices { get; set; } = "[]";

    public string Findings { get; set; } = "[]";

    public string AcknowledgedRisks { get; set; } = "[]";

    public string Bindings { get; set; } = "[]";

    public string Steps { get; set; } = "[]";

    /// <summary>Whether any service builds an image, so the deploy runs docker compose build.</summary>
    public bool Builds { get; set; }

    public bool HasBuildContext { get; set; }

    public Guid? JobId { get; set; }

    public long? DeployedAt { get; set; }

    public long? FinishedAt { get; set; }

    public int? RollbackOf { get; set; }

    public string? Error { get; set; }

    public string? ProjectId { get; set; }

    public string? ProjectName { get; set; }

    public string? ComposePath { get; set; }

    public string? EnvironmentId { get; set; }

    public string? EnvironmentName { get; set; }
}

internal static class StackModel
{
    public static void Configure(ModelBuilder builder)
    {
        builder.Entity<StackRecord>(stack =>
        {
            stack.HasKey(s => s.Id);
            stack.Property(s => s.Name).HasMaxLength(63);
            stack.HasIndex(s => s.Name).IsUnique();
            stack.Property(s => s.Description).HasMaxLength(500);
            stack.Property(s => s.ProjectId).HasMaxLength(100);
            stack.Property(s => s.ProjectName).HasMaxLength(200);
            stack.Property(s => s.ComposePath).HasMaxLength(500);
            stack.Property(s => s.EnvironmentId).HasMaxLength(100);
            stack.Property(s => s.EnvironmentName).HasMaxLength(200);
        });

        builder.Entity<StackRevisionRecord>(revision =>
        {
            revision.HasKey(r => new { r.StackId, r.Number });
            revision.Property(r => r.State).HasMaxLength(30);
            revision.Property(r => r.CreatedBy).HasMaxLength(256);
            revision.Property(r => r.ComposeSha256).HasMaxLength(64);
            revision.Property(r => r.Error).HasMaxLength(2000);
            revision.Property(r => r.ProjectId).HasMaxLength(100);
            revision.Property(r => r.ProjectName).HasMaxLength(200);
            revision.Property(r => r.ComposePath).HasMaxLength(500);
            revision.Property(r => r.EnvironmentId).HasMaxLength(100);
            revision.Property(r => r.EnvironmentName).HasMaxLength(200);
            revision.HasIndex(r => r.State);
            revision.HasOne<StackRecord>().WithMany().HasForeignKey(r => r.StackId).OnDelete(DeleteBehavior.Cascade);
        });
    }
}
