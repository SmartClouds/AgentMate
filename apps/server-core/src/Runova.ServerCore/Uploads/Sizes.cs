using System.Globalization;

namespace Runova.ServerCore.Uploads;

/// <summary>Byte counts the way people read them in a refusal: "256 MB", not 268435456.</summary>
internal static class Sizes
{
    private const long Kilobyte = 1024;
    private const long Megabyte = Kilobyte * 1024;
    private const long Gigabyte = Megabyte * 1024;

    public static string Describe(long bytes) => bytes switch
    {
        >= Gigabyte => string.Create(CultureInfo.InvariantCulture, $"{bytes / (double)Gigabyte:0.#} GB"),
        >= Megabyte => string.Create(CultureInfo.InvariantCulture, $"{bytes / (double)Megabyte:0.#} MB"),
        >= Kilobyte => string.Create(CultureInfo.InvariantCulture, $"{bytes / (double)Kilobyte:0.#} KB"),
        _ => string.Create(CultureInfo.InvariantCulture, $"{bytes} bytes"),
    };
}
