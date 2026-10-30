namespace Runova.Website.Data.Audit;

/// <summary>
/// One change to users, roles, API clients, news or posts. Entries are only ever added; nothing
/// changes or deletes them, and none holds a secret, token, password or signature.
/// </summary>
public class AuditEntry
{
    public long Id { get; set; }

    public DateTimeOffset At { get; set; }

    /// <summary>One of <c>AuditActorKinds</c>.</summary>
    public string ActorKind { get; set; } = "";

    /// <summary>The user or API client that made the change; null for the system.</summary>
    public long? ActorId { get; set; }

    /// <summary>One of <c>AuditActions</c>, as in <c>user.invite</c>.</summary>
    public string Action { get; set; } = "";

    public string TargetType { get; set; } = "";

    public string TargetId { get; set; } = "";

    public string? Ip { get; set; }

    /// <summary>A small JSON object of what changed, with secrets left out.</summary>
    public string? Changes { get; set; }
}
