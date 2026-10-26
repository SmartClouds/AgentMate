using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Runova.ServerCore.Compatibility;

namespace Runova.ServerCore.Security;

internal sealed record AccessTokenPayload(Guid SessionId, Guid UserId, Guid DeviceId, long ExpiresAt);

/// <summary>
/// Access tokens: the session, user, device and expiry, sealed with the core's Data Protection keys.
/// They say who is calling for 15 minutes; the session behind them is still checked on every use,
/// so revoking a device or a session takes effect at once.
/// </summary>
internal sealed class AccessTokens(IDataProtectionProvider protection, TimeProvider time)
{
    public static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(15);

    private readonly IDataProtector _protector = protection.CreateProtector(FrozenIdentifiers.AccessTokenPurpose);

    public (string Token, long ExpiresAt) Issue(Guid sessionId, Guid userId, Guid deviceId)
    {
        var expiresAt = time.GetUtcNow().Add(Lifetime).ToUnixTimeMilliseconds();
        var payload = JsonSerializer.SerializeToUtf8Bytes(new AccessTokenPayload(sessionId, userId, deviceId, expiresAt));
        return (Base64Url.EncodeToString(_protector.Protect(payload)), expiresAt);
    }

    /// <summary>The payload of a token this core issued and that has not expired; otherwise null.</summary>
    public AccessTokenPayload? Read(string token)
    {
        if (string.IsNullOrEmpty(token) || token.Length > 4096)
        {
            return null;
        }

        try
        {
            var payload = JsonSerializer.Deserialize<AccessTokenPayload>(
                _protector.Unprotect(Base64Url.DecodeFromChars(token)));
            return payload is not null && payload.ExpiresAt > time.GetUtcNow().ToUnixTimeMilliseconds() ? payload : null;
        }
        catch (Exception error) when (error is CryptographicException or FormatException or JsonException)
        {
            return null;
        }
    }
}
