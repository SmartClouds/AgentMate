using System.Collections.Concurrent;

namespace Runova.ServerCore.Certificates.Acme;

/// <summary>
/// Nonces the CA handed out in Replay-Nonce headers (RFC 8555 section 6.5), newest first, so a
/// client asks newNonce only when it has none left. Invalid values are ignored, as the RFC says.
/// </summary>
internal sealed class AcmeNoncePool
{
    private const int Capacity = 8;
    private const int MaxLength = 512;

    private readonly ConcurrentStack<string> _nonces = new();

    public static bool IsValid(string? nonce) =>
        nonce is { Length: > 0 and <= MaxLength }
        && nonce.All(character => char.IsAsciiLetterOrDigit(character) || character is '-' or '_');

    public void Add(string? nonce)
    {
        if (!IsValid(nonce))
        {
            return;
        }

        // Old nonces go stale on the server; when the pool is full, start over with the new one.
        if (_nonces.Count >= Capacity)
        {
            _nonces.Clear();
        }

        _nonces.Push(nonce!);
    }

    public string? TryTake() => _nonces.TryPop(out var nonce) ? nonce : null;
}
