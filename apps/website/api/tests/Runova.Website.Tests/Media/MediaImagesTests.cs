using System.Text;
using Runova.Website.Core.Media;
using SkiaSharp;

namespace Runova.Website.Tests.Media;

public class MediaImagesTests
{
    [Fact]
    public void A_png_is_re_encoded_as_a_png_of_the_same_size()
    {
        var image = MediaImages.Process(Png(30, 10), out var error);

        Assert.Null(error);
        Assert.NotNull(image);
        Assert.Equal(("image/png", "png", 30, 10), (image.ContentType, image.Extension, image.Width, image.Height));
        Assert.Equal(30, SKBitmap.Decode(image.Bytes).Width);
    }

    [Fact]
    public void A_jpeg_loses_its_exif_data_and_is_turned_the_way_it_said()
    {
        // 16x8, red on the left and blue on the right, tagged "rotate 90 degrees clockwise to view".
        var jpeg = WithExif(Encode(Halves(16, 8), SKEncodedImageFormat.Jpeg), orientation: 6);

        var image = MediaImages.Process(jpeg, out var error);

        Assert.Null(error);
        Assert.Equal(("image/jpeg", "jpg", 8, 16), (image!.ContentType, image.Extension, image.Width, image.Height));
        Assert.DoesNotContain("Exif", Encoding.Latin1.GetString(image.Bytes), StringComparison.Ordinal);
        Assert.DoesNotContain("Runova Test Camera", Encoding.Latin1.GetString(image.Bytes), StringComparison.Ordinal);
        using var stored = SKBitmap.Decode(image.Bytes);
        Assert.True(stored.GetPixel(4, 2).Red > 200, "The left half turns into the top half.");
        Assert.True(stored.GetPixel(4, 13).Blue > 200, "The right half turns into the bottom half.");
    }

    [Fact]
    public void A_png_keeps_its_transparency_exactly()
    {
        using var bitmap = new SKBitmap(new SKImageInfo(2, 1, SKColorType.Rgba8888, SKAlphaType.Unpremul));
        bitmap.SetPixel(0, 0, new SKColor(10, 200, 30, 77));
        bitmap.SetPixel(1, 0, SKColors.Transparent);

        var image = MediaImages.Process(Encode(bitmap, SKEncodedImageFormat.Png), out _);

        using var stored = SKBitmap.Decode(image!.Bytes, new SKImageInfo(2, 1, SKColorType.Rgba8888, SKAlphaType.Unpremul));
        Assert.Equal(new SKColor(10, 200, 30, 77), stored.GetPixel(0, 0));
        Assert.Equal(0, stored.GetPixel(1, 0).Alpha);
    }

    [Fact]
    public void A_truncated_image_is_refused()
    {
        Assert.Null(MediaImages.Process(Png(40, 20)[..40], out var error));
        Assert.NotNull(error);
    }

    [Fact]
    public void An_oversized_image_is_refused()
    {
        var image = MediaImages.Process(Png(MediaImages.MaxSide + 1, 1), out var error);

        Assert.Null(image);
        Assert.NotNull(error);
    }

    [Theory]
    [InlineData("GIF89a")]
    [InlineData("<svg xmlns=\"http://www.w3.org/2000/svg\"/>")]
    [InlineData("")]
    public void Anything_else_is_refused(string content)
    {
        Assert.Null(MediaImages.Process(Encoding.ASCII.GetBytes(content), out var error));
        Assert.NotNull(error);
    }

    [Fact]
    public void An_avif_with_an_exif_item_is_refused_and_one_without_is_kept_as_it_is()
    {
        var clean = Avif(itemTypes: ["av01"]);
        var withExif = Avif(itemTypes: ["av01", "Exif"]);
        var withXmp = Avif(itemTypes: ["av01", "mime"]);

        var kept = MediaImages.Process(clean, out var keptError);

        Assert.Null(keptError);
        Assert.Equal(("image/avif", "avif", 32, 16), (kept!.ContentType, kept.Extension, kept.Width, kept.Height));
        Assert.Equal(clean, kept.Bytes);
        Assert.Null(MediaImages.Process(withExif, out var exifError));
        Assert.NotNull(exifError);
        Assert.Null(MediaImages.Process(withXmp, out _));
    }

    private static byte[] Png(int width, int height)
    {
        using var bitmap = new SKBitmap(width, height);
        bitmap.Erase(SKColors.CornflowerBlue);
        return Encode(bitmap, SKEncodedImageFormat.Png);
    }

    private static SKBitmap Halves(int width, int height)
    {
        var bitmap = new SKBitmap(width, height);
        using var canvas = new SKCanvas(bitmap);
        canvas.Clear(SKColors.Blue);
        canvas.DrawRect(0, 0, width / 2f, height, new SKPaint { Color = SKColors.Red });
        return bitmap;
    }

    private static byte[] Encode(SKBitmap bitmap, SKEncodedImageFormat format)
    {
        using var data = bitmap.Encode(format, 95);
        return data.ToArray();
    }

    /// <summary>
    /// The JPEG with an EXIF segment right after its start marker: a camera make and an orientation.
    /// Skia writes no EXIF, so the segment is built by hand (big-endian TIFF, one IFD).
    /// </summary>
    private static byte[] WithExif(byte[] jpeg, int orientation)
    {
        byte[] make = [.. "Runova Test Camera"u8, 0];
        const int dataAt = 8 + 2 + (2 * 12) + 4;
        byte[] tiff =
        [
            .. "MM"u8, 0, 42, .. U32(8), .. U16(2),
            .. U16(0x010F), .. U16(2), .. U32(make.Length), .. U32(dataAt),
            .. U16(0x0112), .. U16(3), .. U32(1), .. U16(orientation), 0, 0,
            .. U32(0), .. make,
        ];
        byte[] app1 = [0xFF, 0xE1, .. U16(2 + 6 + tiff.Length), .. "Exif"u8, 0, 0, .. tiff];
        return [.. jpeg[..2], .. app1, .. jpeg[2..]];
    }

    // The boxes the check reads: ftyp, and meta with an iinf entry per item and an ispe of 32x16.
    private static byte[] Avif(string[] itemTypes)
    {
        var infes = itemTypes.Select((type, i) => FullBox("infe", 2, [.. U16(i + 1), .. U16(0), .. Encoding.ASCII.GetBytes(type)])).SelectMany(b => b);
        var iinf = FullBox("iinf", 0, [.. U16(itemTypes.Length), .. infes]);
        var ispe = FullBox("ispe", 0, [.. U32(32), .. U32(16)]);
        var iprp = Box("iprp", Box("ipco", ispe));
        var meta = FullBox("meta", 0, [.. FullBox("hdlr", 0, [.. U32(0), .. "pict"u8, .. new byte[12], 0]), .. iinf, .. iprp]);
        var ftyp = Box("ftyp", [.. "avif"u8, .. U32(0), .. "avif"u8, .. "mif1"u8]);
        return [.. ftyp, .. meta, .. Box("mdat", [1, 2, 3])];
    }

    private static byte[] Box(string type, byte[] content) => [.. U32(8 + content.Length), .. Encoding.ASCII.GetBytes(type), .. content];

    private static byte[] FullBox(string type, byte version, byte[] content) => Box(type, [version, 0, 0, 0, .. content]);

    private static byte[] U16(int value) => [(byte)(value >> 8), (byte)value];

    private static byte[] U32(int value) => [(byte)(value >> 24), (byte)(value >> 16), (byte)(value >> 8), (byte)value];
}
