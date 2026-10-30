using System.Buffers.Binary;
using System.Runtime.InteropServices;
using System.Text;
using SkiaSharp;

namespace Runova.Website.Core.Media;

/// <summary>An upload that passed the checks: the bytes to store and what they are.</summary>
public sealed record ProcessedImage(byte[] Bytes, string ContentType, string Extension, int Width, int Height);

/// <summary>
/// Checks an upload and makes the file to store. The type comes from the leading bytes only.
/// PNG, JPEG and WebP are decoded and their pixels re-encoded into a new image, so no EXIF, XMP,
/// ICC profile, comment or text chunk survives. Skia encodes no AVIF, so an AVIF is stored as it
/// came once its boxes show no EXIF or XMP item.
/// </summary>
public static class MediaImages
{
    public const long MaxBytes = 5 * 1024 * 1024;

    /// <summary>The longest side an upload may have, so a small file can not decode into gigabytes.</summary>
    public const int MaxSide = 8000;

    private const string Unsupported = "Upload a PNG, JPEG, WebP or AVIF image.";
    private const string Unreadable = "The file is not a readable image.";

    private static readonly byte[] _png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

    private enum Kind
    {
        Png,
        Jpeg,
        Webp,
        Avif,
    }

    /// <summary>The file to store, or null with the reason in <paramref name="error"/>.</summary>
    public static ProcessedImage? Process(byte[] data, out string? error)
    {
        error = null;
        switch (Sniff(data))
        {
            case null:
                error = Unsupported;
                return null;
            case Kind.Avif:
                return Avif(data, out error);
            case { } kind:
                return ReEncode(data, kind, out error);
        }
    }

    private static Kind? Sniff(byte[] data)
    {
        var span = data.AsSpan();
        if (span.StartsWith(_png))
        {
            return Kind.Png;
        }

        if (span.StartsWith((byte[])[0xFF, 0xD8, 0xFF]))
        {
            return Kind.Jpeg;
        }

        if (span.Length >= 12 && span[..4].SequenceEqual("RIFF"u8) && span[8..12].SequenceEqual("WEBP"u8))
        {
            return Kind.Webp;
        }

        return IsAvif(span) ? Kind.Avif : null;
    }

    private static ProcessedImage? ReEncode(byte[] data, Kind kind, out string? error)
    {
        using var codec = SKCodec.Create(SKData.CreateCopy(data));
        if (codec is null)
        {
            error = Unreadable;
            return null;
        }

        if (codec.Info.Width > MaxSide || codec.Info.Height > MaxSide)
        {
            error = $"An image is at most {MaxSide} pixels on a side.";
            return null;
        }

        // Unpremultiplied and with no color space, so the pixels come out as stored and no ICC profile goes back in.
        using var decoded = new SKBitmap(new SKImageInfo(codec.Info.Width, codec.Info.Height, SKColorType.Rgba8888, SKAlphaType.Unpremul));
        if (codec.GetPixels(decoded.Info, decoded.GetPixels()) != SKCodecResult.Success)
        {
            error = Unreadable;
            return null;
        }

        using var upright = Orient(decoded, codec.EncodedOrigin);
        var (contentType, extension, format) = kind switch
        {
            Kind.Png => ("image/png", "png", SKEncodedImageFormat.Png),
            Kind.Jpeg => ("image/jpeg", "jpg", SKEncodedImageFormat.Jpeg),
            _ => ("image/webp", "webp", SKEncodedImageFormat.Webp),
        };
        using var encoded = upright.Encode(format, 90);
        if (encoded is null)
        {
            error = Unreadable;
            return null;
        }

        error = null;
        return new ProcessedImage(encoded.ToArray(), contentType, extension, upright.Width, upright.Height);
    }

    /// <summary>
    /// A new bitmap with the pixels turned the way the EXIF orientation says, since that tag goes
    /// with the rest of the metadata. It is a copy even when nothing turns, so the caller disposes both.
    /// </summary>
    private static SKBitmap Orient(SKBitmap source, SKEncodedOrigin origin)
    {
        var (w, h) = (source.Width, source.Height);
        var swaps = origin is SKEncodedOrigin.LeftTop or SKEncodedOrigin.RightTop or SKEncodedOrigin.RightBottom or SKEncodedOrigin.LeftBottom;
        var target = new SKBitmap(new SKImageInfo(swaps ? h : w, swaps ? w : h, SKColorType.Rgba8888, SKAlphaType.Unpremul));
        var from = MemoryMarshal.Cast<byte, uint>(source.GetPixelSpan());
        var to = MemoryMarshal.Cast<byte, uint>(target.GetPixelSpan());
        if (origin == SKEncodedOrigin.TopLeft)
        {
            from.CopyTo(to);
            return target;
        }

        for (var y = 0; y < h; y++)
        {
            for (var x = 0; x < w; x++)
            {
                var (tx, ty) = origin switch
                {
                    SKEncodedOrigin.TopRight => (w - 1 - x, y),
                    SKEncodedOrigin.BottomRight => (w - 1 - x, h - 1 - y),
                    SKEncodedOrigin.BottomLeft => (x, h - 1 - y),
                    SKEncodedOrigin.LeftTop => (y, x),
                    SKEncodedOrigin.RightTop => (h - 1 - y, x),
                    SKEncodedOrigin.RightBottom => (h - 1 - y, w - 1 - x),
                    SKEncodedOrigin.LeftBottom => (y, w - 1 - x),
                    _ => (x, y),
                };
                to[(ty * target.Width) + tx] = from[(y * w) + x];
            }
        }

        return target;
    }

    private static bool IsAvif(ReadOnlySpan<byte> data)
    {
        if (data.Length < 16 || !data[4..8].SequenceEqual("ftyp"u8))
        {
            return false;
        }

        var size = (int)Math.Min(BinaryPrimitives.ReadUInt32BigEndian(data), (uint)data.Length);
        for (var offset = 8; offset + 4 <= size; offset += offset == 8 ? 8 : 4)
        {
            var brand = data.Slice(offset, 4);
            if (brand.SequenceEqual("avif"u8) || brand.SequenceEqual("avis"u8))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Reads the size from the <c>ispe</c> property and refuses EXIF items, XMP (<c>mime</c>)
    /// items and top-level <c>uuid</c> boxes, where XMP may sit too.
    /// </summary>
    private static ProcessedImage? Avif(byte[] data, out string? error)
    {
        var top = Boxes(data, 0, data.Length);
        var meta = top?.FirstOrDefault(b => b.Type == "meta");
        var children = meta is { } m ? Boxes(data, m.Start + 4, m.End) : null;
        if (top is null || children is null)
        {
            error = Unreadable;
            return null;
        }

        var itemTypes = children.Where(b => b.Type == "iinf").SelectMany(b => ItemTypes(data, b)).ToList();
        if (top.Any(b => b.Type == "uuid") || itemTypes.Any(t => t is "Exif" or "mime"))
        {
            error = "This AVIF carries EXIF or XMP metadata, which can not be stripped from it. Export it without metadata.";
            return null;
        }

        var properties = children.Where(b => b.Type == "iprp").SelectMany(b => Boxes(data, b.Start, b.End) ?? []).Where(b => b.Type == "ipco");
        var ispe = properties.SelectMany(b => Boxes(data, b.Start, b.End) ?? []).FirstOrDefault(b => b.Type == "ispe");
        if (ispe is not { } size || size.End - size.Start < 12)
        {
            error = Unreadable;
            return null;
        }

        var width = BinaryPrimitives.ReadUInt32BigEndian(data.AsSpan(size.Start + 4));
        var height = BinaryPrimitives.ReadUInt32BigEndian(data.AsSpan(size.Start + 8));
        if (width is 0 or > MaxSide || height is 0 or > MaxSide)
        {
            error = $"An image is at most {MaxSide} pixels on a side.";
            return null;
        }

        error = null;
        return new ProcessedImage(data, "image/avif", "avif", (int)width, (int)height);
    }

    // An iinf is a full box with an entry count, 16 bits in version 0, then its infe boxes.
    private static IEnumerable<string> ItemTypes(byte[] data, Box iinf)
    {
        var entriesStart = iinf.Start + (data[iinf.Start] == 0 ? 6 : 8);
        foreach (var infe in Boxes(data, entriesStart, iinf.End) ?? [])
        {
            // Versions 2 and 3 name the type after the item id (16 or 32 bits) and protection index.
            var version = data[infe.Start];
            var typeAt = infe.Start + 4 + (version == 3 ? 4 : 2) + 2;
            if (version >= 2 && typeAt + 4 <= infe.End)
            {
                yield return Encoding.ASCII.GetString(data, typeAt, 4);
            }
        }
    }

    private sealed record Box(string Type, int Start, int End);

    /// <summary>The ISO BMFF boxes from <paramref name="start"/> to <paramref name="end"/>, by content range; null when one is malformed.</summary>
    private static List<Box>? Boxes(byte[] data, int start, int end)
    {
        var boxes = new List<Box>();
        var offset = start;
        while (offset + 8 <= end)
        {
            long size = BinaryPrimitives.ReadUInt32BigEndian(data.AsSpan(offset));
            var header = 8;
            if (size == 1)
            {
                if (offset + 16 > end)
                {
                    return null;
                }

                size = (long)BinaryPrimitives.ReadUInt64BigEndian(data.AsSpan(offset + 8));
                header = 16;
            }
            else if (size == 0)
            {
                size = end - offset;
            }

            if (size < header || offset + size > end)
            {
                return null;
            }

            boxes.Add(new Box(Encoding.ASCII.GetString(data, offset + 4, 4), offset + header, (int)(offset + size)));
            offset += (int)size;
        }

        return offset == end ? boxes : null;
    }
}
