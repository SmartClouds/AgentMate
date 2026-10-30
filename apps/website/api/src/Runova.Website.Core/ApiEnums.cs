using System.Collections.Frozen;
using System.Text.Json;

namespace Runova.Website.Core;

/// <summary>
/// The contract's lowercase strings for an enum: its member names in kebab case, as in
/// <c>end-of-life</c>. JSON uses the same naming policy, so a query parameter and a body read alike.
/// </summary>
public static class ApiEnums
{
    public static JsonNamingPolicy NamingPolicy => JsonNamingPolicy.KebabCaseLower;

    public static string Name<T>(T value)
        where T : struct, Enum => Names<T>.ByValue[value];

    /// <summary>Takes only the exact contract string, never a number or another casing.</summary>
    public static bool TryParse<T>(string? text, out T value)
        where T : struct, Enum => Names<T>.ByName.TryGetValue(text ?? "", out value);

    private static class Names<T>
        where T : struct, Enum
    {
        public static readonly FrozenDictionary<T, string> ByValue =
            Enum.GetValues<T>().ToFrozenDictionary(v => v, v => NamingPolicy.ConvertName(v.ToString()));

        public static readonly FrozenDictionary<string, T> ByName =
            ByValue.ToFrozenDictionary(pair => pair.Value, pair => pair.Key, StringComparer.Ordinal);
    }
}
