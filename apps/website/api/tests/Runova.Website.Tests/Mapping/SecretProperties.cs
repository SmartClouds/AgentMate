using System.Reflection;

namespace Runova.Website.Tests.Mapping;

/// <summary>
/// Finds properties a DTO must never carry: password hashes, security stamps, tokens, secret
/// hashes and signing keys. Every mapper's test runs its output type through this.
/// </summary>
internal static class SecretProperties
{
    private static readonly string[] _forbidden = ["password", "securitystamp", "token", "secret", "signingkey"];

    public static IReadOnlyList<string> In(Type type) =>
        [.. type.GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Select(p => p.Name)
            .Where(name => _forbidden.Any(word => name.Contains(word, StringComparison.OrdinalIgnoreCase)))];
}
