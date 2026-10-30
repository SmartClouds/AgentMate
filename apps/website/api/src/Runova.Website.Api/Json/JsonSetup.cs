using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi;

namespace Runova.Website.Api.Json;

internal static class JsonSetup
{
    /// <summary>
    /// The contract's JSON rules: an unknown property in a request body is refused, and times are
    /// written in UTC with a Z, to the millisecond.
    /// </summary>
    public static IServiceCollection AddWebsiteJson(this IServiceCollection services) =>
        services.ConfigureHttpJsonOptions(options =>
        {
            options.SerializerOptions.UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow;
            options.SerializerOptions.Converters.Add(new UtcTimeConverter());
        });

    /// <summary>
    /// A custom converter hides the time's JSON type from the OpenAPI generator, so the schema
    /// would say only "format: date-time". This puts the string type back.
    /// </summary>
    public static Task DescribeTimes(OpenApiSchema schema, OpenApiSchemaTransformerContext context, CancellationToken cancellationToken)
    {
        var type = context.JsonTypeInfo.Type;
        if (type == typeof(DateTimeOffset))
        {
            schema.Type = JsonSchemaType.String;
        }
        else if (type == typeof(DateTimeOffset?))
        {
            schema.Type = JsonSchemaType.String | JsonSchemaType.Null;
        }

        return Task.CompletedTask;
    }

    private sealed class UtcTimeConverter : JsonConverter<DateTimeOffset>
    {
        private const string Format = "yyyy-MM-dd'T'HH:mm:ss.fff'Z'";

        public override DateTimeOffset Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
            reader.GetDateTimeOffset();

        public override void Write(Utf8JsonWriter writer, DateTimeOffset value, JsonSerializerOptions options) =>
            writer.WriteStringValue(value.UtcDateTime.ToString(Format, CultureInfo.InvariantCulture));
    }
}
