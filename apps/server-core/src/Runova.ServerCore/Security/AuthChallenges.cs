using System.Buffers.Text;
using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using Runova.ServerCore.Compatibility;
using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.Security;

/// <summary>
/// The text a device signs. Every field that decides what the signature is good for is in it:
/// the purpose, the challenge, the device and (for a renewal) the session, so a signature made
/// for one of them cannot be replayed as another.
/// </summary>
internal static class AuthMessage
{
    public const string Prefix = "runova-core/auth/v1";

    /// <summary>What a signature may start with: an app from before the rename signs with the old prefix, for good.</summary>
    public static readonly IReadOnlyList<string> Prefixes = [Prefix, LegacyNames.AuthPrefix];

    public static string For(AuthPurpose purpose, Guid challengeId, string nonce, Guid deviceId, Guid? sessionId, string prefix = Prefix) =>
        string.Join(
            '\n',
            prefix,
            purpose == AuthPurpose.Login ? "login" : "renew",
            challengeId.ToString("D"),
            nonce,
            deviceId.ToString("D"),
            sessionId?.ToString("D") ?? "-");

    /// <summary>Whether <paramref name="signature"/> signs this challenge under either prefix.</summary>
    public static bool Verify(byte[] publicKey, byte[] signature, AuthPurpose purpose, Guid challengeId, string nonce, Guid deviceId, Guid? sessionId) =>
        Prefixes.Any(prefix => DeviceKeys.Verify(
            publicKey,
            Encoding.UTF8.GetBytes(For(purpose, challengeId, nonce, deviceId, sessionId, prefix)),
            signature));
}

internal sealed record IssuedChallenge(
    Guid Id,
    string Nonce,
    Guid DeviceId,
    AuthPurpose Purpose,
    Guid? SessionId,
    long ExpiresAt);

/// <summary>
/// Outstanding challenges, in memory: single use, one minute each. A restart forgets them, which
/// only means the app asks again.
/// </summary>
internal sealed class AuthChallenges(TimeProvider time)
{
    public static readonly TimeSpan Lifetime = TimeSpan.FromSeconds(60);

    /// <summary>Enough for every device of every user many times over, and a bound on memory.</summary>
    private const int MaxOutstanding = 1_000;

    private readonly ConcurrentDictionary<Guid, IssuedChallenge> _issued = new();

    /// <summary>A new challenge, or null when too many are outstanding.</summary>
    public IssuedChallenge? Issue(Guid deviceId, AuthPurpose purpose, Guid? sessionId)
    {
        var now = time.GetUtcNow().ToUnixTimeMilliseconds();
        foreach (var (id, stale) in _issued)
        {
            if (stale.ExpiresAt <= now)
            {
                _issued.TryRemove(id, out _);
            }
        }

        if (_issued.Count >= MaxOutstanding)
        {
            return null;
        }

        var challenge = new IssuedChallenge(
            Guid.NewGuid(),
            Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(32)),
            deviceId,
            purpose,
            sessionId,
            now + (long)Lifetime.TotalMilliseconds);
        _issued[challenge.Id] = challenge;
        return challenge;
    }

    /// <summary>
    /// Removes the challenge before anything else is checked, so it can never be tried twice, and
    /// returns it only while it is valid for exactly this purpose and session. The caller compares
    /// the device it was issued to.
    /// </summary>
    public IssuedChallenge? Take(Guid challengeId, AuthPurpose purpose, Guid? sessionId)
    {
        if (!_issued.TryRemove(challengeId, out var challenge))
        {
            return null;
        }

        var valid = challenge.ExpiresAt > time.GetUtcNow().ToUnixTimeMilliseconds()
            && challenge.Purpose == purpose
            && challenge.SessionId == sessionId;
        return valid ? challenge : null;
    }
}
