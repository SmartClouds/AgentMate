using System.Text.Json;
using System.Text.Json.Serialization;

namespace Runova.ServerCore;

/// <summary>
/// One JSON shape for REST, the hub and the admin CLI. It matches the TypeScript that Tapper
/// generates: camelCase names, absent instead of null (optional fields are typed as `?:`), and
/// enums as camelCase strings.
/// </summary>
internal static class CoreJson
{
    public static JsonSerializerOptions Options { get; } =
        Configure(new JsonSerializerOptions(JsonSerializerDefaults.Web));

    public static JsonSerializerOptions Configure(JsonSerializerOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        options.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
        options.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull;
        options.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.CamelCase));
        return options;
    }
}
