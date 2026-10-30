using System.Globalization;
using System.Security.Claims;
using System.Text.Json;
using Runova.Website.Core.Audit;
using Runova.Website.Data;
using Runova.Website.Data.Audit;

namespace Runova.Website.Api.Audit;

/// <summary>
/// Adds audit entries to the request's <see cref="AppDbContext"/>, so an entry is saved with the
/// change it describes or not at all.
/// </summary>
internal sealed class AuditLog(AppDbContext db, IHttpContextAccessor http, TimeProvider time)
{
    private static readonly JsonSerializerOptions _json = new(JsonSerializerDefaults.Web);

    /// <summary>
    /// An entry by the signed-in user, or by <paramref name="actorId"/> when the request has none
    /// (a user setting their password from a link). <paramref name="changes"/> must hold no secret.
    /// </summary>
    public void Add(string action, string targetType, long targetId, object? changes = null, long? actorId = null) =>
        Add(AuditActorKinds.User, actorId ?? SignedInUserId(http.HttpContext?.User), action, targetType, targetId, changes);

    /// <summary>An entry by the system itself, such as a background job.</summary>
    public void AddBySystem(string action, string targetType, long targetId, object? changes = null) =>
        Add(AuditActorKinds.System, null, action, targetType, targetId, changes);

    /// <summary>The id of the signed-in user, when there is one.</summary>
    public static long? SignedInUserId(ClaimsPrincipal? user) =>
        long.TryParse(user?.FindFirstValue(ClaimTypes.NameIdentifier), CultureInfo.InvariantCulture, out var id) ? id : null;

    private void Add(string actorKind, long? actorId, string action, string targetType, long targetId, object? changes)
    {
        var context = http.HttpContext;
        db.AuditEntries.Add(new AuditEntry
        {
            At = time.GetUtcNow(),
            ActorKind = actorKind,
            ActorId = actorId,
            Action = action,
            TargetType = targetType,
            TargetId = targetId.ToString(CultureInfo.InvariantCulture),
            Ip = context?.Connection.RemoteIpAddress?.ToString(),
            Changes = changes is null ? null : JsonSerializer.Serialize(changes, _json),
        });
    }
}
