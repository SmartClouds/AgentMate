using System.Text.Json.Nodes;

namespace Runova.Website.Core.Json;

/// <summary>JSON Merge Patch (RFC 7396), the body of every PATCH in the API.</summary>
public static class MergePatch
{
    /// <summary>
    /// The target with the patch applied: a member set to null is removed, an object is merged
    /// member by member, and anything else, arrays included, replaces what was there. Neither
    /// argument is changed.
    /// </summary>
    public static JsonNode? Apply(JsonNode? target, JsonNode? patch)
    {
        if (patch is not JsonObject members)
        {
            return patch?.DeepClone();
        }

        var result = target is JsonObject existing ? (JsonObject)existing.DeepClone() : [];
        foreach (var (name, value) in members)
        {
            if (value is null)
            {
                result.Remove(name);
            }
            else
            {
                result[name] = Apply(result[name], value);
            }
        }

        return result;
    }
}
