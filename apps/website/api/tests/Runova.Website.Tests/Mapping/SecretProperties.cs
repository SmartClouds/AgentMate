using System.Reflection;

namespace Runova.Website.Tests.Mapping;

/// <summary>
/// Finds properties a DTO must never carry: password hashes, security stamps, tokens, secret
/// hashes and signing keys. Every mapper's test runs its output type through this. It also looks
/// inside the website's own types a DTO holds, alone or in a list, and names those as
/// <c>Outer.Inner</c>.
/// </summary>
internal static class SecretProperties
{
    private static readonly string[] _forbidden = ["password", "securitystamp", "concurrencystamp", "token", "secret", "signingkey", "authenticatorkey", "recoverycode"];

    public static IReadOnlyList<string> In(Type type) => [.. Walk(type, prefix: "", path: [])];

    // The path holds the types above this one, so a type that holds itself ends the walk.
    private static IEnumerable<string> Walk(Type type, string prefix, HashSet<Type> path)
    {
        if (path.Contains(type))
        {
            yield break;
        }

        foreach (var property in type.GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            var name = prefix + property.Name;
            if (_forbidden.Any(word => property.Name.Contains(word, StringComparison.OrdinalIgnoreCase)))
            {
                yield return name;
            }

            if (OwnType(property.PropertyType) is { } inner)
            {
                foreach (var nested in Walk(inner, name + ".", [.. path, type]))
                {
                    yield return nested;
                }
            }
        }
    }

    // The type itself, or the element type of a list of it, when it is one of the website's.
    private static Type? OwnType(Type type)
    {
        var element = type.IsGenericType ? type.GetGenericArguments().FirstOrDefault() ?? type : type;
        return element.Namespace?.StartsWith("Runova.Website", StringComparison.Ordinal) == true ? element : null;
    }
}
