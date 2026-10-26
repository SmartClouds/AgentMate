using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Runova.ServerCore.Nginx;

/// <summary>
/// SHA-512 crypt (<c>$6$</c>), the strongest scheme every glibc and libxcrypt build of crypt()
/// understands, which is what nginx's basic auth calls. This follows Ulrich Drepper's
/// specification ("Unix crypt using SHA-256 and SHA-512"). MD5 (<c>$apr1$</c>) and plain text,
/// which nginx also accepts, are never produced or accepted by Runova.
/// </summary>
/// <remarks>
/// nginx checks the password on every request, in the worker that serves it, so the rounds stay
/// at the scheme's default unless there is a reason to pay more per request.
/// </remarks>
internal static partial class Sha512Crypt
{
    public const int DefaultRounds = 5000;
    public const int MinRounds = 1000;
    public const int MaxRounds = 999_999_999;
    public const int SaltLength = 16;

    private const string Alphabet = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

    /// <summary>The order in which the specification spreads the 64 digest bytes over the 86 characters.</summary>
    private static readonly int[] _order =
    [
        0, 21, 42, 22, 43, 1, 44, 2, 23, 3, 24, 45, 25, 46, 4, 47, 5, 26, 6, 27, 48, 28, 49, 7,
        50, 8, 29, 9, 30, 51, 31, 52, 10, 53, 11, 32, 12, 33, 54, 34, 55, 13, 56, 14, 35, 15, 36, 57,
        37, 58, 16, 59, 17, 38, 18, 39, 60, 40, 61, 19, 62, 20, 41,
    ];

    /// <summary>A new hash with a random 16-character salt.</summary>
    public static string Hash(string password, int rounds = DefaultRounds)
    {
        var salt = new char[SaltLength];
        for (var i = 0; i < salt.Length; i++)
        {
            salt[i] = Alphabet[RandomNumberGenerator.GetInt32(Alphabet.Length)];
        }

        return Hash(password, new string(salt), rounds);
    }

    /// <summary>
    /// The hash for a given salt, which is cut to 16 characters as the scheme does. Rounds are
    /// clamped to what the scheme allows and written into the hash unless they are the default.
    /// </summary>
    public static string Hash(string password, string salt, int rounds = DefaultRounds)
    {
        ArgumentNullException.ThrowIfNull(password);
        ArgumentNullException.ThrowIfNull(salt);
        if (salt.Length == 0 || !salt.All(c => Alphabet.Contains(c, StringComparison.Ordinal)))
        {
            throw new ArgumentException("A salt is 1 to 16 characters from ./0-9A-Za-z.", nameof(salt));
        }

        var saltText = salt.Length > SaltLength ? salt[..SaltLength] : salt;
        var effectiveRounds = Math.Clamp(rounds, MinRounds, MaxRounds);
        var digest = Digest(Encoding.UTF8.GetBytes(password), Encoding.ASCII.GetBytes(saltText), effectiveRounds);

        var result = new StringBuilder(128);
        result.Append("$6$");
        if (effectiveRounds != DefaultRounds)
        {
            result.Append(CultureInfo.InvariantCulture, $"rounds={effectiveRounds}$");
        }

        result.Append(saltText).Append('$');
        for (var i = 0; i < _order.Length; i += 3)
        {
            AppendBase64(result, digest[_order[i]], digest[_order[i + 1]], digest[_order[i + 2]], 4);
        }

        AppendBase64(result, 0, 0, digest[63], 2);
        return result.ToString();
    }

    /// <summary>Whether the password matches the hash; false for anything that is not a well-formed $6$ hash.</summary>
    public static bool Verify(string password, string hash)
    {
        ArgumentNullException.ThrowIfNull(password);
        if (!TryParse(hash, out var salt, out var rounds, out var encoded))
        {
            return false;
        }

        var computed = Hash(password, salt, rounds);
        return CryptographicOperations.FixedTimeEquals(
            Encoding.ASCII.GetBytes(computed[^encoded.Length..]),
            Encoding.ASCII.GetBytes(encoded));
    }

    /// <summary>A well-formed SHA-512 crypt hash, as crypt() writes them.</summary>
    public static bool IsHash(string? text) => TryParse(text, out _, out _, out _);

    /// <summary>The rounds a hash asks for, which is what nginx pays on every request.</summary>
    public static int RoundsOf(string hash) =>
        TryParse(hash, out _, out var rounds, out _) ? rounds : throw new ArgumentException("Not a SHA-512 crypt hash.", nameof(hash));

    private static bool TryParse(string? text, out string salt, out int rounds, out string encoded)
    {
        salt = encoded = string.Empty;
        rounds = DefaultRounds;
        if (text is null)
        {
            return false;
        }

        var match = HashPattern().Match(text);
        if (!match.Success)
        {
            return false;
        }

        if (match.Groups["rounds"].Success)
        {
            if (!int.TryParse(match.Groups["rounds"].Value, NumberStyles.None, CultureInfo.InvariantCulture, out rounds)
                || rounds is < MinRounds or > MaxRounds)
            {
                return false;
            }
        }

        salt = match.Groups["salt"].Value;
        encoded = match.Groups["hash"].Value;
        return true;
    }

    private static byte[] Digest(byte[] password, byte[] salt, int rounds)
    {
        using var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA512);

        // Digest B: password, salt, password.
        sha.AppendData(password);
        sha.AppendData(salt);
        sha.AppendData(password);
        var b = sha.GetHashAndReset();

        // Digest A: password, salt, B stretched to the password's length, then B or the password
        // for each bit of the password's length, lowest bit first.
        sha.AppendData(password);
        sha.AppendData(salt);
        AppendRepeated(sha, b, password.Length);
        for (var length = password.Length; length > 0; length >>= 1)
        {
            sha.AppendData((length & 1) != 0 ? b : password);
        }

        var a = sha.GetHashAndReset();

        // P: the password repeated as often as it is long, hashed, stretched to its length.
        for (var i = 0; i < password.Length; i++)
        {
            sha.AppendData(password);
        }

        var p = Stretch(sha.GetHashAndReset(), password.Length);

        // S: the salt repeated 16 + A[0] times, hashed, cut to the salt's length.
        for (var i = 0; i < 16 + a[0]; i++)
        {
            sha.AppendData(salt);
        }

        var s = Stretch(sha.GetHashAndReset(), salt.Length);

        var c = a;
        for (var round = 0; round < rounds; round++)
        {
            sha.AppendData((round & 1) != 0 ? p : c);
            if (round % 3 != 0)
            {
                sha.AppendData(s);
            }

            if (round % 7 != 0)
            {
                sha.AppendData(p);
            }

            sha.AppendData((round & 1) != 0 ? c : p);
            c = sha.GetHashAndReset();
        }

        return c;
    }

    private static void AppendRepeated(IncrementalHash sha, byte[] block, int length)
    {
        var remaining = length;
        for (; remaining > block.Length; remaining -= block.Length)
        {
            sha.AppendData(block);
        }

        sha.AppendData(block, 0, remaining);
    }

    private static byte[] Stretch(byte[] block, int length)
    {
        var result = new byte[length];
        for (var offset = 0; offset < length; offset += block.Length)
        {
            Array.Copy(block, 0, result, offset, Math.Min(block.Length, length - offset));
        }

        return result;
    }

    private static void AppendBase64(StringBuilder result, byte high, byte middle, byte low, int count)
    {
        var word = (high << 16) | (middle << 8) | low;
        for (var i = 0; i < count; i++)
        {
            result.Append(Alphabet[word & 0x3f]);
            word >>= 6;
        }
    }

    [GeneratedRegex("^\\$6\\$(?:rounds=(?<rounds>[1-9][0-9]{0,8})\\$)?(?<salt>[./0-9A-Za-z]{1,16})\\$(?<hash>[./0-9A-Za-z]{86})\\z", RegexOptions.CultureInvariant)]
    private static partial Regex HashPattern();
}
