namespace Runova.Website.Core.ApiClients;

/// <summary>
/// Another system that writes through the API with signed requests. It holds no secret: each key
/// keeps only its signing key (the secret's SHA-256), sealed with Data Protection.
/// </summary>
public class ApiClient
{
    public long Id { get; set; }

    public string Name { get; set; } = "";

    /// <summary>Some of <see cref="ApiScopes.All"/>.</summary>
    public List<string> Scopes { get; set; } = [];

    /// <summary>IPv4 and IPv6 addresses and CIDR ranges; empty means any address.</summary>
    public List<string> IpAllowlist { get; set; } = [];

    /// <summary>The client's keys: the current one, and the one before it while its overlap lasts.</summary>
    public List<ApiClientKey> Keys { get; set; } = [];

    public DateTimeOffset? ExpiresAt { get; set; }

    public DateTimeOffset? RevokedAt { get; set; }

    public DateTimeOffset? LastUsedAt { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    /// <summary>PostgreSQL's <c>xmin</c>; the ETag and <c>version</c>.</summary>
    public uint Version { get; set; }
}

public class ApiClientKey
{
    /// <summary><c>rk_</c> and 16 lowercase hex characters, unique across clients.</summary>
    public string KeyId { get; set; } = "";

    /// <summary>The SHA-256 of the secret, sealed with Data Protection. Never the secret.</summary>
    public string SealedSigningKey { get; set; } = "";

    public DateTimeOffset CreatedAt { get; set; }

    /// <summary>Null for the current key; the end of the overlap for one that was rotated out.</summary>
    public DateTimeOffset? ExpiresAt { get; set; }
}

/// <summary>What an API client may write.</summary>
public static class ApiScopes
{
    public const string NewsWrite = "news:write";
    public const string PostsWrite = "posts:write";

    public static IReadOnlyList<string> All { get; } = [NewsWrite, PostsWrite];
}
