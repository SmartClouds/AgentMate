namespace Runova.Website.Data.ApiClients;

/// <summary>
/// The first answer to a POST with an <c>Idempotency-Key</c>, kept for 24 hours per caller so a
/// retry gets it again instead of making a second item.
/// </summary>
public class IdempotencyRecord
{
    public long Id { get; set; }

    /// <summary><c>user</c> or <c>api-client</c>, as in <c>AuditActorKinds</c>.</summary>
    public string CallerKind { get; set; } = "";

    public long CallerId { get; set; }

    public string Key { get; set; } = "";

    /// <summary>The SHA-256 of the request body, so the same key with another body is refused.</summary>
    public byte[] RequestHash { get; set; } = [];

    /// <summary>The answer's status; 0 while the first request is still running.</summary>
    public int StatusCode { get; set; }

    public string? ContentType { get; set; }

    public string? Location { get; set; }

    public string? ETag { get; set; }

    public string? Body { get; set; }

    public DateTimeOffset CreatedAt { get; set; }
}
