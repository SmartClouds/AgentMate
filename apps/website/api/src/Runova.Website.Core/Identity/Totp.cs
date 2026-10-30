using System.Buffers.Binary;
using System.Security.Cryptography;

namespace Runova.Website.Core.Identity;

/// <summary>RFC 6238 time-based one-time codes: HMAC-SHA-1, 6 digits, 30 second steps.</summary>
public static class Totp
{
    public const int Digits = 6;
    public static readonly TimeSpan Step = TimeSpan.FromSeconds(30);

    /// <summary>How many steps before or after the current one a code may come from.</summary>
    public const int AllowedDrift = 1;

    public static long TimeStep(DateTimeOffset time) => time.ToUnixTimeSeconds() / (long)Step.TotalSeconds;

    public static string Code(ReadOnlySpan<byte> key, long timeStep)
    {
        Span<byte> counter = stackalloc byte[8];
        BinaryPrimitives.WriteInt64BigEndian(counter, timeStep);
        Span<byte> hash = stackalloc byte[HMACSHA1.HashSizeInBytes];
#pragma warning disable CA5350 // RFC 6238 and every authenticator app use SHA-1 here; HMAC-SHA-1 is not broken.
        HMACSHA1.HashData(key, counter, hash);
#pragma warning restore CA5350

        // Dynamic truncation, RFC 4226 section 5.3.
        var offset = hash[^1] & 0x0f;
        var binary = BinaryPrimitives.ReadInt32BigEndian(hash[offset..]) & 0x7fffffff;
        return (binary % 1_000_000).ToString("D6", System.Globalization.CultureInfo.InvariantCulture);
    }

    /// <summary>
    /// The time step a code belongs to, looking one step either side of <paramref name="now"/>, or
    /// null when it matches none. Spaces and dashes in the code are ignored.
    /// </summary>
    public static long? FindStep(ReadOnlySpan<byte> key, string code, DateTimeOffset now)
    {
        var digits = code.Replace(" ", "", StringComparison.Ordinal).Replace("-", "", StringComparison.Ordinal);
        if (digits.Length != Digits || !digits.All(char.IsAsciiDigit))
        {
            return null;
        }

        var current = TimeStep(now);
        for (var step = current - AllowedDrift; step <= current + AllowedDrift; step++)
        {
            if (CryptographicOperations.FixedTimeEquals(
                System.Text.Encoding.ASCII.GetBytes(Code(key, step)), System.Text.Encoding.ASCII.GetBytes(digits)))
            {
                return step;
            }
        }

        return null;
    }
}
