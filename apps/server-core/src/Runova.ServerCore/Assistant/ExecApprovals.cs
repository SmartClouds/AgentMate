using System.Buffers.Text;
using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using Runova.ServerCore.Compatibility;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Assistant;

/// <summary>A nonce handed to one session, to sign once for one command.</summary>
internal sealed record IssuedExecNonce(Guid Id, string Nonce, Guid SessionId, Guid DeviceId, long ExpiresAt);

/// <summary>
/// Approvals for commands that are not on the allowlist. The app asks for a nonce, the user's
/// device signs the nonce with the exact command text (<see cref="Message"/>), and the core checks
/// that signature against the device's enrolled key before it runs anything. A nonce is good once,
/// for two minutes, on the session it was issued to: a signature cannot be replayed, moved to
/// another session or reused for a different command.
/// </summary>
/// <remarks>Kept in memory, as auth challenges are: a restart only means the app asks again.</remarks>
internal sealed class ExecApprovals(TimeProvider time)
{
    public const string Prefix = "runova-core/exec/v1";

    /// <summary>An app from before the rename signs with the old prefix; both are accepted for good.</summary>
    public static readonly IReadOnlyList<string> Prefixes = [Prefix, LegacyNames.ExecPrefix];

    public static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(2);

    private const int MaxOutstanding = 1_000;

    private const int MaxPerSession = 16;

    private readonly ConcurrentDictionary<Guid, IssuedExecNonce> _issued = new();

    /// <summary>The text a device signs to approve <paramref name="command"/>.</summary>
    public static string Message(Guid nonceId, string nonce, Guid deviceId, Guid sessionId, string command, string prefix = Prefix) =>
        string.Join('\n', prefix, nonceId.ToString("D"), nonce, deviceId.ToString("D"), sessionId.ToString("D"), command);

    /// <summary>A new nonce, or null when too many are outstanding (in all or for this session).</summary>
    public IssuedExecNonce? Issue(Guid sessionId, Guid deviceId)
    {
        var now = time.GetUtcNow().ToUnixTimeMilliseconds();
        foreach (var (id, stale) in _issued)
        {
            if (stale.ExpiresAt <= now)
            {
                _issued.TryRemove(id, out _);
            }
        }

        if (_issued.Count >= MaxOutstanding || _issued.Values.Count(n => n.SessionId == sessionId) >= MaxPerSession)
        {
            return null;
        }

        var issued = new IssuedExecNonce(
            Guid.NewGuid(),
            Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(32)),
            sessionId,
            deviceId,
            now + (long)Lifetime.TotalMilliseconds);
        _issued[issued.Id] = issued;
        return issued;
    }

    /// <summary>
    /// Checks an approval and uses its nonce up, whatever the outcome: the nonce is removed before
    /// anything else is looked at, so a wrong guess cannot be followed by a right one. True only for
    /// a live nonce of this session and device, signed over exactly this command by
    /// <paramref name="publicKey"/>.
    /// </summary>
    public bool Verify(Guid nonceId, string? signature, Guid sessionId, Guid deviceId, byte[] publicKey, string command)
    {
        ArgumentNullException.ThrowIfNull(publicKey);
        ArgumentNullException.ThrowIfNull(command);
        if (!_issued.TryRemove(nonceId, out var issued))
        {
            return false;
        }

        if (issued.ExpiresAt <= time.GetUtcNow().ToUnixTimeMilliseconds()
            || issued.SessionId != sessionId
            || issued.DeviceId != deviceId
            || string.IsNullOrEmpty(signature)
            || signature.Length > 512)
        {
            return false;
        }

        byte[] bytes;
        try
        {
            bytes = Convert.FromBase64String(signature);
        }
        catch (FormatException)
        {
            return false;
        }

        return Prefixes.Any(prefix => DeviceKeys.Verify(
            publicKey,
            Encoding.UTF8.GetBytes(Message(issued.Id, issued.Nonce, deviceId, sessionId, command, prefix)),
            bytes));
    }
}

/// <summary>
/// Which sessions turned "auto-run diagnostics" on. In memory on purpose: a restart of the core
/// puts every session back on approving every command, the safe default.
/// </summary>
internal sealed class AssistantModes
{
    private readonly ConcurrentDictionary<Guid, bool> _autoRun = new();

    public bool AutoRuns(Guid sessionId) => _autoRun.ContainsKey(sessionId);

    public void Set(Guid sessionId, bool autoRun)
    {
        if (autoRun)
        {
            _autoRun[sessionId] = true;
        }
        else
        {
            _autoRun.TryRemove(sessionId, out _);
        }
    }
}
