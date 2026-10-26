using Microsoft.EntityFrameworkCore;

namespace Runova.ServerCore.Data;

// Private registries (E08): credentials stored on the server for pulls nobody signs in for.

/// <summary>
/// One registry's credential. The secret is sealed with Data Protection under its own purpose
/// (RegistryCredentials.Purpose) and is only ever unsealed inside a job that pulls; no API returns
/// it. The registry is the canonical host (docker.io for Docker Hub), one row per registry.
/// </summary>
internal sealed class RegistryCredentialRecord
{
    public Guid Id { get; set; }

    public required string Registry { get; set; }

    public required string Username { get; set; }

    /// <summary>Base64 of the Data Protection payload.</summary>
    public required string SealedSecret { get; set; }

    public long CreatedAt { get; set; }

    public long UpdatedAt { get; set; }

    public string? CreatedBy { get; set; }

    public long? LastUsedAt { get; set; }
}

internal static class RegistryModel
{
    public static void Configure(ModelBuilder builder)
    {
        builder.Entity<RegistryCredentialRecord>(credential =>
        {
            credential.HasKey(c => c.Id);
            credential.Property(c => c.Registry).HasMaxLength(260);
            credential.HasIndex(c => c.Registry).IsUnique();
            credential.Property(c => c.Username).HasMaxLength(255);
            credential.Property(c => c.CreatedBy).HasMaxLength(256);
        });
    }
}
