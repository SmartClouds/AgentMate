using Microsoft.EntityFrameworkCore;
using Npgsql;
using Runova.Website.Core.Audit;
using Runova.Website.Core.News;
using Runova.Website.Data;

namespace Runova.Website.Api.Http;

/// <summary>What the news and post writes share: saving under a unique slug, and naming who wrote something.</summary>
internal static class Writes
{
    /// <summary>Saves, or answers false when a unique index (the slug) was taken by a write that won the race.</summary>
    public static async Task<bool> TrySaveAsync(AppDbContext db)
    {
        try
        {
            await db.SaveChangesAsync();
            return true;
        }
        catch (DbUpdateException e) when (e.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
        {
            return false;
        }
    }

    /// <summary>The user or API client by its audit actor kind and id, with its name; null when there is none.</summary>
    public static async Task<NewsCreatorDto?> CreatorAsync(AppDbContext db, string kind, long? id)
    {
        var name = (kind, id) switch
        {
            (AuditActorKinds.User, { } userId) =>
                await db.Users.AsNoTracking().Where(u => u.Id == userId).Select(u => u.DisplayName).SingleOrDefaultAsync(),
            (AuditActorKinds.ApiClient, { } clientId) =>
                await db.ApiClients.AsNoTracking().Where(c => c.Id == clientId).Select(c => c.Name).SingleOrDefaultAsync(),
            _ => null,
        };
        return name is null ? null : new NewsCreatorDto(kind, id!.Value, name);
    }
}
