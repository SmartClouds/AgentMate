using System.Reflection;

namespace Runova.ServerCore;

/// <summary>Which core is running, as the installer and the app see it.</summary>
internal static class CoreVersion
{
    /// <summary>Bumped only when the contract between the app and the core changes incompatibly.</summary>
    public const int ApiVersion = 1;

    public static string Current { get; } = Read();

    private static string Read()
    {
        var informational = typeof(CoreVersion).Assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()
            ?.InformationalVersion;
        if (string.IsNullOrWhiteSpace(informational))
        {
            return "0.0.0-dev";
        }

        // The SDK appends "+<commit>" for source link; the installer compares plain versions.
        var plus = informational.IndexOf('+', StringComparison.Ordinal);
        return plus < 0 ? informational : informational[..plus];
    }
}
