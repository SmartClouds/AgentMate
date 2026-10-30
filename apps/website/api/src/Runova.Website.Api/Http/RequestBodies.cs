using System.ComponentModel.DataAnnotations;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Validation;

namespace Runova.Website.Api.Http;

/// <summary>
/// Request bodies an endpoint reads itself rather than binds, so every way a body can be wrong
/// ends as a 400 <c>validation-failed</c> keyed by the JSON path of the field at fault.
/// </summary>
internal static partial class RequestBodies
{
    public const string BodyKey = "body";

    /// <summary>The body as a JSON object, or null with an error when it is not one.</summary>
    public static async Task<JsonObject?> ReadObjectAsync(HttpRequest request, IDictionary<string, string[]> errors)
    {
        try
        {
            if (await JsonNode.ParseAsync(request.Body, cancellationToken: request.HttpContext.RequestAborted) is JsonObject body)
            {
                return body;
            }
        }
        catch (JsonException)
        {
        }

        errors[BodyKey] = ["Send a JSON object."];
        return null;
    }

    /// <summary>
    /// The node as a <typeparamref name="T"/>, or default with an error naming the property that
    /// could not be read: an unknown one, or a value of the wrong type.
    /// </summary>
    public static T? Deserialize<T>(JsonNode node, JsonSerializerOptions options, IDictionary<string, string[]> errors)
    {
        try
        {
            return node.Deserialize<T>(options);
        }
        catch (JsonException e)
        {
            var key = ToKey(e.Path);
            if (UnmappedName().Match(e.Message) is { Success: true } match)
            {
                var name = match.Groups[1].Value;
                key = key == BodyKey ? name : key.EndsWith(name, StringComparison.Ordinal) ? key : $"{key}.{name}";
                errors[key] = ["This field is not part of the resource."];
            }
            else
            {
                errors[key] = ["This is not a valid value for the field."];
            }

            return default;
        }
    }

    /// <summary>
    /// Runs the built-in validation (data annotations, then <see cref="IValidatableObject"/>) on
    /// a type marked <c>[ValidatableType]</c>, with errors keyed by camelCase JSON paths.
    /// </summary>
    // .NET 10 marks the API for running the validation by hand as experimental.
#pragma warning disable ASP0029
    public static async Task<Dictionary<string, string[]>> ValidateAsync<T>(T value, HttpContext http)
        where T : notnull
    {
        var options = http.RequestServices.GetRequiredService<IOptions<ValidationOptions>>().Value;
        if (!options.TryGetValidatableTypeInfo(typeof(T), out var info))
        {
            throw new InvalidOperationException($"{typeof(T).Name} is not validatable. Mark it [ValidatableType] and call AddValidation.");
        }

        var context = new ValidateContext
        {
            ValidationContext = new ValidationContext(value, http.RequestServices, null),
            ValidationOptions = options,
        };
        await info.ValidateAsync(value, context, http.RequestAborted);
        return context.ValidationErrors?.ToDictionary(e => ToCamelCase(e.Key), e => e.Value) ?? [];
    }
#pragma warning restore ASP0029

    // System.Text.Json writes "$.technologies[0].versionRange"; the root itself is the body.
    private static string ToKey(string? path) =>
        path is null or "$" ? BodyKey : path.StartsWith("$.", StringComparison.Ordinal) ? path[2..] : path;

    // "Technologies[1].Technology" becomes "technologies[1].technology".
    private static string ToCamelCase(string path) =>
        path.Length == 0 ? BodyKey : string.Join('.', path.Split('.').Select(JsonNamingPolicy.CamelCase.ConvertName));

    [GeneratedRegex("The JSON property '([^']+)' could not be mapped")]
    private static partial Regex UnmappedName();
}
