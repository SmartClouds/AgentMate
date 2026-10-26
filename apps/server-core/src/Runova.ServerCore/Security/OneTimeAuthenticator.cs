using System.Buffers.Binary;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Identity;
using Runova.ServerCore.Data;

namespace Runova.ServerCore.Security;

/// <summary>
/// Authenticator app codes that work once (RFC 6238, section 5.2): a code, and every code older
/// than one already accepted, is refused afterwards, so a code read over a shoulder or out of a
/// log is of no use once it was typed. Codes count for one 30-second step either side of now, the
/// most the RFC recommends, where Identity's own provider allows two.
/// </summary>
/// <remarks>
/// Registered under Identity's authenticator name, so sign-in, step-up and turning two-factor on
/// or off all check codes through it.
/// </remarks>
internal sealed class OneTimeAuthenticatorTokenProvider(TimeProvider time) : IUserTwoFactorTokenProvider<CoreUser>
{
    public const int AcceptedSteps = 1;

    public async Task<bool> CanGenerateTwoFactorTokenAsync(UserManager<CoreUser> manager, CoreUser user)
    {
        ArgumentNullException.ThrowIfNull(manager);
        return !string.IsNullOrWhiteSpace(await manager.GetAuthenticatorKeyAsync(user));
    }

    /// <summary>The app on the phone makes the codes; the core only checks them.</summary>
    public Task<string> GenerateAsync(string purpose, UserManager<CoreUser> manager, CoreUser user) =>
        Task.FromResult(string.Empty);

    public async Task<bool> ValidateAsync(string purpose, string token, UserManager<CoreUser> manager, CoreUser user)
    {
        ArgumentNullException.ThrowIfNull(manager);
        ArgumentNullException.ThrowIfNull(user);
        if (token is not { Length: Totp.Digits } || !token.All(char.IsAsciiDigit))
        {
            return false;
        }

        var key = await manager.GetAuthenticatorKeyAsync(user);
        var secret = key is null ? null : Totp.DecodeKey(key);
        if (secret is not { Length: > 0 })
        {
            return false;
        }

        var typed = Encoding.ASCII.GetBytes(token);
        var now = time.GetUtcNow().ToUnixTimeSeconds() / Totp.StepSeconds;
        for (var step = now - AcceptedSteps; step <= now + AcceptedSteps; step++)
        {
            if (step <= user.LastTotpStep
                || !CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(Totp.Code(secret, step)), typed))
            {
                continue;
            }

            // Spent as it is accepted. When one code arrives twice at once, the user's concurrency
            // stamp lets only the first save through, and the other use fails.
            user.LastTotpStep = step;
            return (await manager.UpdateAsync(user)).Succeeded;
        }

        return false;
    }
}

/// <summary>RFC 6238 codes over HMAC-SHA1, the one variant every authenticator app supports.</summary>
internal static class Totp
{
    public const int StepSeconds = 30;
    public const int Digits = 6;

    private const string Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

    public static string Code(ReadOnlySpan<byte> secret, long step)
    {
        Span<byte> counter = stackalloc byte[8];
        BinaryPrimitives.WriteInt64BigEndian(counter, step);
        Span<byte> hash = stackalloc byte[HMACSHA1.HashSizeInBytes];
        // RFC 6238 defines authenticator codes over HMAC-SHA1. As an HMAC it needs no collision
        // resistance, and the apps offer nothing else.
#pragma warning disable CA5350
        HMACSHA1.HashData(secret, counter, hash);
#pragma warning restore CA5350
        var offset = hash[^1] & 0x0f;
        var binary = ((hash[offset] & 0x7f) << 24) | (hash[offset + 1] << 16) | (hash[offset + 2] << 8) | hash[offset + 3];
        return (binary % 1_000_000).ToString("D6", CultureInfo.InvariantCulture);
    }

    /// <summary>
    /// A base32 key (RFC 4648) the way apps show it: any case, spaces and padding allowed. Null
    /// when it holds anything else, or nothing.
    /// </summary>
    public static byte[]? DecodeKey(string key)
    {
        ArgumentNullException.ThrowIfNull(key);
        var output = new List<byte>(key.Length * 5 / 8);
        var buffer = 0;
        var bits = 0;
        foreach (var character in key)
        {
            if (character is ' ' or '=')
            {
                continue;
            }

            var value = Alphabet.IndexOf(char.ToUpperInvariant(character), StringComparison.Ordinal);
            if (value < 0)
            {
                return null;
            }

            buffer = (buffer << 5) | value;
            bits += 5;
            if (bits >= 8)
            {
                bits -= 8;
                output.Add((byte)(buffer >> bits));
                buffer &= (1 << bits) - 1;
            }
        }

        return output.Count == 0 ? null : [.. output];
    }
}
