namespace Runova.Website.Core.ApiClients;

public sealed record ApiClientDto(
    long Id,
    string Name,
    IReadOnlyList<string> Scopes,
    IReadOnlyList<string> IpAllowlist,
    IReadOnlyList<ApiClientKeyDto> Keys,
    DateTimeOffset? ExpiresAt,
    DateTimeOffset? RevokedAt,
    DateTimeOffset? LastUsedAt,
    DateTimeOffset CreatedAt,
    string Version);

public sealed record ApiClientKeyDto(string KeyId, DateTimeOffset CreatedAt, DateTimeOffset? ExpiresAt);

/// <summary>The answer to creating a client: the only time its first secret is ever shown.</summary>
public sealed record ApiClientCreatedDto(ApiClientDto Client, string KeyId, string Secret);

/// <summary>The answer to a rotation: the only time the new secret is ever shown.</summary>
public sealed record ApiClientSecretDto(string KeyId, string Secret, DateTimeOffset PreviousKeyExpiresAt);
