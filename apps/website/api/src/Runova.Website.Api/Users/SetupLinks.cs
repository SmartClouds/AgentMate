using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Runova.Website.Api.Http;
using Runova.Website.Core.Users;
using Runova.Website.Data;
using Runova.Website.Data.Identity;

namespace Runova.Website.Api.Users;

/// <summary>
/// Issues and redeems the one-time links users set their password with: 32 random bytes in
/// base64url, stored only as their SHA-256, good for 24 hours and for one use.
/// </summary>
internal sealed class SetupLinks(AppDbContext db, TimeProvider time, IConfiguration configuration)
{
    public static readonly TimeSpan Lifetime = TimeSpan.FromHours(24);

    /// <summary>
    /// Replaces any link the user has with a new one. The new link is added to the context, so the
    /// caller saves it with the rest of the change.
    /// </summary>
    public async Task<SetupLinkDto> IssueAsync(AppUser user, string purpose)
    {
        await db.SetupLinks.Where(l => l.UserId == user.Id).ExecuteDeleteAsync();

        var token = Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(32));
        var now = time.GetUtcNow();
        var link = new SetupLink { UserId = user.Id, Purpose = purpose, TokenHash = Hash(token), CreatedAt = now, ExpiresAt = now + Lifetime };
        db.SetupLinks.Add(link);

        return new SetupLinkDto($"{SiteUrl.From(configuration)}/admin/set-password#token={token}", link.ExpiresAt);
    }

    /// <summary>The link a token belongs to while it has not expired, or null.</summary>
    public Task<SetupLink?> FindAsync(string token)
    {
        var hash = Hash(token);
        var now = time.GetUtcNow();
        return db.SetupLinks.SingleOrDefaultAsync(l => l.TokenHash == hash && l.ExpiresAt > now);
    }

    /// <summary>Deletes a link; false when another request used it first.</summary>
    public async Task<bool> UseAsync(SetupLink link) =>
        await db.SetupLinks.Where(l => l.Id == link.Id).ExecuteDeleteAsync() == 1;

    private static byte[] Hash(string token) => SHA256.HashData(Encoding.ASCII.GetBytes(token));
}
