using System.Security.Cryptography;
using System.Text;

namespace Runova.ServerCore.Docker;

/// <summary>
/// Just enough OpenPGP (RFC 4880) to check a repository key before trusting it: take the armor
/// off, walk the packets, and compute each primary key's v4 fingerprint, SHA-1 over 0x99, the
/// two-byte packet length and the key packet. Anything that does not parse has no fingerprint.
/// </summary>
internal static class OpenPgpKey
{
    private const int PublicKeyTag = 6;

    /// <summary>True when the text holds exactly one primary key and it has this fingerprint.</summary>
    public static bool HasOnly(string armored, string fingerprint)
    {
        var found = PrimaryFingerprints(armored);
        return found.Count == 1 && string.Equals(found[0], Normalize(fingerprint), StringComparison.Ordinal);
    }

    /// <summary>Upper-case hex, no spaces, one per primary key (subkeys are not listed).</summary>
    public static IReadOnlyList<string> PrimaryFingerprints(string armored)
    {
        ArgumentNullException.ThrowIfNull(armored);
        var fingerprints = new List<string>();
        foreach (var block in Dearmor(armored))
        {
            if (!TryReadPackets(block, fingerprints))
            {
                return [];
            }
        }

        return fingerprints;
    }

    public static string Normalize(string fingerprint) =>
        fingerprint.Replace(" ", string.Empty, StringComparison.Ordinal).ToUpperInvariant();

    private static IEnumerable<byte[]> Dearmor(string armored)
    {
        var lines = armored.Replace("\r", string.Empty, StringComparison.Ordinal).Split('\n');
        var index = 0;
        while (index < lines.Length)
        {
            if (lines[index].Trim() != "-----BEGIN PGP PUBLIC KEY BLOCK-----")
            {
                index++;
                continue;
            }

            index++;
            // Armor headers (Version:, Comment:) end at the first blank line.
            while (index < lines.Length && lines[index].Trim().Length > 0)
            {
                index++;
            }

            var body = new StringBuilder();
            while (index < lines.Length && !lines[index].StartsWith('=') && !lines[index].StartsWith("-----", StringComparison.Ordinal))
            {
                body.Append(lines[index].Trim());
                index++;
            }

            byte[] bytes;
            try
            {
                bytes = Convert.FromBase64String(body.ToString());
            }
            catch (FormatException)
            {
                bytes = [];
            }

            yield return bytes;
        }
    }

    private static bool TryReadPackets(byte[] data, List<string> fingerprints)
    {
        if (data.Length == 0)
        {
            return false;
        }

        var position = 0;
        while (position < data.Length)
        {
            var header = data[position++];
            if ((header & 0x80) == 0)
            {
                return false;
            }

            int tag;
            long length;
            if ((header & 0x40) != 0)
            {
                tag = header & 0x3f;
                if (!TryNewLength(data, ref position, out length))
                {
                    return false;
                }
            }
            else
            {
                tag = (header >> 2) & 0x0f;
                var octets = (header & 0x03) switch { 0 => 1, 1 => 2, 2 => 4, _ => 0 };
                if (octets == 0 || position + octets > data.Length)
                {
                    return false;
                }

                length = 0;
                for (var i = 0; i < octets; i++)
                {
                    length = (length << 8) | data[position++];
                }
            }

            if (length < 0 || position + length > data.Length)
            {
                return false;
            }

            if (tag == PublicKeyTag)
            {
                var packet = data.AsSpan(position, (int)length);
                if (packet.Length == 0 || packet[0] != 4 || packet.Length > ushort.MaxValue)
                {
                    return false;
                }

                var hashed = new byte[packet.Length + 3];
                hashed[0] = 0x99;
                hashed[1] = (byte)(packet.Length >> 8);
                hashed[2] = (byte)packet.Length;
                packet.CopyTo(hashed.AsSpan(3));
                // The v4 fingerprint is defined as SHA-1 (RFC 4880 12.2); it identifies, it does not protect.
#pragma warning disable CA5350
                fingerprints.Add(Convert.ToHexString(SHA1.HashData(hashed)));
#pragma warning restore CA5350
            }

            position += (int)length;
        }

        return true;
    }

    /// <summary>A new-format length; partial lengths never occur in keys and are refused.</summary>
    private static bool TryNewLength(byte[] data, ref int position, out long length)
    {
        length = 0;
        if (position >= data.Length)
        {
            return false;
        }

        var first = data[position++];
        if (first < 192)
        {
            length = first;
            return true;
        }

        if (first < 224)
        {
            if (position >= data.Length)
            {
                return false;
            }

            length = ((first - 192) << 8) + data[position++] + 192;
            return true;
        }

        if (first == 255 && position + 4 <= data.Length)
        {
            length = ((long)data[position] << 24) | ((long)data[position + 1] << 16) | ((long)data[position + 2] << 8) | data[position + 3];
            position += 4;
            return true;
        }

        return false;
    }
}
