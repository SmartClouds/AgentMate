using System.Globalization;
using System.Text;
using System.Text.Json;

namespace Runova.ServerCore.Certificates.Acme;

/// <summary>
/// Reads ACME resources without trusting their shape: a member of the wrong JSON type counts as
/// absent, so a strange answer ends in a clear "missing" error instead of a parser exception.
/// </summary>
internal static class AcmeJson
{
    private static readonly JsonDocumentOptions _options = new() { MaxDepth = 16 };

    /// <summary>The document when the bytes are a JSON object, otherwise null.</summary>
    public static JsonDocument? TryParseObject(ReadOnlyMemory<byte> json)
    {
        try
        {
            var document = JsonDocument.Parse(json, _options);
            if (document.RootElement.ValueKind == JsonValueKind.Object)
            {
                return document;
            }

            document.Dispose();
            return null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    public static string? ReadString(this JsonElement element, string name) =>
        Member(element, name) is { ValueKind: JsonValueKind.String } value ? value.GetString() : null;

    public static bool? ReadBoolean(this JsonElement element, string name) =>
        Member(element, name) is { ValueKind: JsonValueKind.True or JsonValueKind.False } value ? value.GetBoolean() : null;

    public static int? ReadInt32(this JsonElement element, string name) =>
        Member(element, name) is { ValueKind: JsonValueKind.Number } value && value.TryGetInt32(out var number) ? number : null;

    public static JsonElement? ReadObject(this JsonElement element, string name) =>
        Member(element, name) is { ValueKind: JsonValueKind.Object } value ? value : null;

    public static IEnumerable<JsonElement> ReadObjects(this JsonElement element, string name) =>
        Member(element, name) is { ValueKind: JsonValueKind.Array } array
            ? array.EnumerateArray().Where(item => item.ValueKind == JsonValueKind.Object)
            : [];

    public static IReadOnlyList<string> ReadStrings(this JsonElement element, string name) =>
        Member(element, name) is { ValueKind: JsonValueKind.Array } array
            ? [.. array.EnumerateArray().Where(item => item.ValueKind == JsonValueKind.String).Select(item => item.GetString()!)]
            : [];

    /// <summary>An RFC 3339 timestamp. Go servers write nine fraction digits; .NET parses seven.</summary>
    public static DateTimeOffset? ReadTimestamp(this JsonElement element, string name) =>
        ParseTimestamp(element.ReadString(name));

    public static DateTimeOffset? ParseTimestamp(string? text)
    {
        if (string.IsNullOrWhiteSpace(text) || text.Length > 64)
        {
            return null;
        }

        var dot = text.IndexOf('.', StringComparison.Ordinal);
        if (dot > 0)
        {
            var end = dot + 1;
            while (end < text.Length && char.IsAsciiDigit(text[end]))
            {
                end++;
            }

            if (end - dot - 1 > 7)
            {
                text = string.Concat(text.AsSpan(0, dot + 8), text.AsSpan(end));
            }
        }

        return DateTimeOffset.TryParse(
            text,
            CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
            out var parsed)
            ? parsed
            : null;
    }

    /// <summary>Writes a JSON object with a writer, for request payloads.</summary>
    public static byte[] Write(Action<Utf8JsonWriter> write)
    {
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            write(writer);
            writer.WriteEndObject();
        }

        return buffer.ToArray();
    }

    private static JsonElement? Member(JsonElement element, string name) =>
        element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) ? value : null;
}

/// <summary>Text from a CA goes into exceptions and logs, so it is made single-line and short first.</summary>
internal static class AcmeText
{
    public const int MaxLength = 500;

    public static string? Clean(string? text, int maxLength = MaxLength)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return null;
        }

        var builder = new StringBuilder(Math.Min(text.Length, maxLength + 1));
        var space = false;
        foreach (var character in text)
        {
            if (char.IsControl(character) || char.IsWhiteSpace(character))
            {
                space = builder.Length > 0;
                continue;
            }

            if (space)
            {
                builder.Append(' ');
                space = false;
            }

            builder.Append(character);
            if (builder.Length > maxLength)
            {
                break;
            }
        }

        if (builder.Length > maxLength)
        {
            builder.Length = maxLength - 3;
            builder.Append("...");
        }

        return builder.ToString();
    }
}
