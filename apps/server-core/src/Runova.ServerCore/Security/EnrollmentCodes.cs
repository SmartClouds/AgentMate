using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Runova.ServerCore.Data;

namespace Runova.ServerCore.Security;

/// <summary>
/// Single-use codes an Owner creates so another device can enroll without SSH access. The code
/// is shown once; the core keeps its SHA-256 (100 random bits make a salt unnecessary).
/// </summary>
internal sealed class EnrollmentCodes(CoreDbContext db, TimeProvider time)
{
    public static readonly TimeSpan DefaultValidity = TimeSpan.FromMinutes(15);
    public static readonly TimeSpan MaxValidity = TimeSpan.FromHours(24);

    private const string Alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    public async Task<(string Code, long ExpiresAt)> CreateAsync(
        Guid userId,
        Guid createdBy,
        TimeSpan validity,
        CancellationToken cancellationToken)
    {
        var bytes = RandomNumberGenerator.GetBytes(20);
        var characters = bytes.Select(b => Alphabet[b % Alphabet.Length]).ToArray();
        var code = string.Join('-', characters.Chunk(5).Select(chunk => new string(chunk)));
        var now = time.GetUtcNow().ToUnixTimeMilliseconds();
        var expiresAt = now + (long)validity.TotalMilliseconds;
        db.EnrollmentCodes.Add(new EnrollmentCode
        {
            Id = Guid.NewGuid(),
            UserId = userId,
            CreatedBy = createdBy,
            CodeHash = Hash(code),
            CreatedAt = now,
            ExpiresAt = expiresAt,
        });
        await db.SaveChangesAsync(cancellationToken);
        return (code, expiresAt);
    }

    /// <summary>An unused, unexpired code for this user, without spending it.</summary>
    public async Task<EnrollmentCode?> FindAsync(string? code, Guid userId, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(code) || code.Length > 64)
        {
            return null;
        }

        var hash = Hash(code);
        var now = time.GetUtcNow().ToUnixTimeMilliseconds();
        return await db.EnrollmentCodes.FirstOrDefaultAsync(
            c => c.CodeHash == hash && c.UserId == userId && c.RedeemedAt == null && c.ExpiresAt > now,
            cancellationToken);
    }

    /// <summary>Codes are compared without dashes, spaces or case, the way people type them.</summary>
    public static string Hash(string code)
    {
        ArgumentNullException.ThrowIfNull(code);
        var normalized = new string(code.Where(char.IsLetterOrDigit).Select(char.ToUpperInvariant).ToArray());
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(normalized)));
    }
}
