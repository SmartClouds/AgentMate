using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace Runova.Website.Core.Caching;

/// <summary>
/// ETags for responses that have no single row version. A single row's strong ETag is its
/// <c>xmin</c> instead.
/// </summary>
public static class ETags
{
    /// <summary>
    /// The weak tag of a public list: a hash of the request's path and query, the newest
    /// <c>updatedAt</c> and the count of the matching rows, so any change to what matches changes it.
    /// </summary>
    public static string ForList(string pathAndQuery, DateTimeOffset? newestUpdate, int count)
    {
        var newest = newestUpdate?.UtcTicks.ToString(CultureInfo.InvariantCulture) ?? "none";
        return $"W/\"{Hash($"{pathAndQuery}\n{newest}\n{count.ToString(CultureInfo.InvariantCulture)}")}\"";
    }

    /// <summary>A strong tag over content that is the same byte for byte whenever the tag is.</summary>
    public static string ForContent(string content) => $"\"{Hash(content)}\"";

    // Half of a SHA-256 is plenty to tell versions of a response apart.
    private static string Hash(string text) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text)).AsSpan(0, 16));
}
