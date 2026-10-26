using System.Security.Cryptography;

namespace Runova.ServerCore.Nginx;

/// <summary>Text that is not the OpenPGP public key it claims to be.</summary>
internal sealed class OpenPgpFormatException(string message) : Exception(message);

/// <summary>
/// Just enough OpenPGP (RFC 4880) to check a repository key without gpg, which minimal servers do
/// not have: undo the ASCII armor (with its CRC-24), walk the packets, and compute the v4
/// fingerprint of every primary key. The binary keyring that comes out is what apt's signed-by and
/// rpm's gpgkey read.
/// </summary>
internal static class OpenPgpKeys
{
    public const int MaxArmoredLength = 256 * 1024;

    private const string Begin = "-----BEGIN PGP PUBLIC KEY BLOCK-----";
    private const string End = "-----END PGP PUBLIC KEY BLOCK-----";
    private const int PublicKeyTag = 6;

    /// <summary>Every armored block, decoded and joined in order.</summary>
    /// <exception cref="OpenPgpFormatException">No block, a broken block, or a checksum that does not match.</exception>
    public static byte[] Dearmor(string armored)
    {
        ArgumentNullException.ThrowIfNull(armored);
        if (armored.Length > MaxArmoredLength)
        {
            throw new OpenPgpFormatException("The key file is far larger than any repository key.");
        }

        var lines = armored.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n');
        var output = new List<byte>();
        var blocks = 0;
        for (var i = 0; i < lines.Length; i++)
        {
            if (lines[i].Trim() != Begin)
            {
                continue;
            }

            // Armor headers ("Version: ...") run to the first empty line.
            i++;
            while (i < lines.Length && lines[i].Trim().Length > 0 && lines[i].Contains(':', StringComparison.Ordinal))
            {
                i++;
            }

            var base64 = new System.Text.StringBuilder();
            string? checksum = null;
            for (; i < lines.Length && lines[i].Trim() != End; i++)
            {
                var line = lines[i].Trim();
                if (line.StartsWith('='))
                {
                    checksum = line[1..];
                }
                else
                {
                    base64.Append(line);
                }
            }

            if (i >= lines.Length)
            {
                throw new OpenPgpFormatException("A key block is not closed.");
            }

            byte[] data;
            try
            {
                data = Convert.FromBase64String(base64.ToString());
            }
            catch (FormatException)
            {
                throw new OpenPgpFormatException("A key block is not valid base64.");
            }

            if (checksum is not null && !Crc24Matches(data, checksum))
            {
                throw new OpenPgpFormatException("A key block's checksum does not match its contents.");
            }

            output.AddRange(data);
            blocks++;
        }

        return blocks == 0 ? throw new OpenPgpFormatException("The text holds no OpenPGP public key block.") : [.. output];
    }

    /// <summary>The fingerprints of the primary keys, as 40 uppercase hex digits.</summary>
    /// <exception cref="OpenPgpFormatException">The packets do not parse, or a primary key is not version 4.</exception>
    public static IReadOnlyList<string> PrimaryFingerprints(ReadOnlySpan<byte> keyring)
    {
        var fingerprints = new List<string>();
        var position = 0;
        while (position < keyring.Length)
        {
            var (tag, start, length) = ReadPacket(keyring, ref position);
            var body = keyring.Slice(start, length);
            if (tag != PublicKeyTag)
            {
                continue;
            }

            if (body.Length < 6 || body[0] != 4)
            {
                throw new OpenPgpFormatException("A primary key is not an OpenPGP version 4 key.");
            }

            // RFC 4880 section 12.2: SHA-1 over 0x99, the two-byte body length and the body.
            var hashed = new byte[body.Length + 3];
            hashed[0] = 0x99;
            hashed[1] = (byte)(body.Length >> 8);
            hashed[2] = (byte)body.Length;
            body.CopyTo(hashed.AsSpan(3));
#pragma warning disable CA5350 // OpenPGP v4 fingerprints are SHA-1 by definition; this is identification, not a signature.
            fingerprints.Add(Convert.ToHexString(SHA1.HashData(hashed)));
#pragma warning restore CA5350
        }

        return fingerprints;
    }

    private static (int Tag, int Start, int Length) ReadPacket(ReadOnlySpan<byte> data, ref int position)
    {
        var header = data[position++];
        if ((header & 0x80) == 0)
        {
            throw new OpenPgpFormatException("The key data is not a sequence of OpenPGP packets.");
        }

        int tag;
        long length;
        if ((header & 0x40) != 0)
        {
            tag = header & 0x3f;
            var first = Byte(data, ref position);
            if (first < 192)
            {
                length = first;
            }
            else if (first < 224)
            {
                length = ((first - 192) << 8) + Byte(data, ref position) + 192;
            }
            else if (first == 255)
            {
                length = Number(data, ref position, 4);
            }
            else
            {
                throw new OpenPgpFormatException("Key packets may not use partial lengths.");
            }
        }
        else
        {
            tag = (header >> 2) & 0x0f;
            length = (header & 3) switch
            {
                0 => Number(data, ref position, 1),
                1 => Number(data, ref position, 2),
                2 => Number(data, ref position, 4),
                _ => throw new OpenPgpFormatException("Key packets may not have an indeterminate length."),
            };
        }

        if (length > data.Length - position)
        {
            throw new OpenPgpFormatException("A key packet runs past the end of the data.");
        }

        var start = position;
        position += (int)length;
        return (tag, start, (int)length);
    }

    private static int Byte(ReadOnlySpan<byte> data, ref int position) =>
        position < data.Length ? data[position++] : throw new OpenPgpFormatException("The key data ends inside a packet header.");

    private static long Number(ReadOnlySpan<byte> data, ref int position, int bytes)
    {
        long value = 0;
        for (var i = 0; i < bytes; i++)
        {
            value = (value << 8) | (uint)Byte(data, ref position);
        }

        return value;
    }

    /// <summary>RFC 4880 section 6.1.</summary>
    private static bool Crc24Matches(byte[] data, string checksum)
    {
        byte[] expected;
        try
        {
            expected = Convert.FromBase64String(checksum);
        }
        catch (FormatException)
        {
            return false;
        }

        var crc = 0xB704CEu;
        foreach (var value in data)
        {
            crc ^= (uint)value << 16;
            for (var bit = 0; bit < 8; bit++)
            {
                crc <<= 1;
                if ((crc & 0x1000000) != 0)
                {
                    crc ^= 0x1864CFBu;
                }
            }
        }

        crc &= 0xFFFFFF;
        return expected.Length == 3 && expected[0] == (byte)(crc >> 16) && expected[1] == (byte)(crc >> 8) && expected[2] == (byte)crc;
    }
}
