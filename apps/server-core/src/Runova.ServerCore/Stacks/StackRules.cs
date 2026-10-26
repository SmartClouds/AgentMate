using System.Text.RegularExpressions;

namespace Runova.ServerCore.Stacks;

/// <summary>
/// The names a stack's requests carry, checked the way the app checks them
/// (packages/core/src/deploy/validation.ts): stack names are compose project names and folder
/// names, service names are compose's, env keys are what the Environments tab reads.
/// </summary>
internal static partial class StackRules
{
    public const int MaxNameLength = 63;

    public const int MaxEnvKeyLength = 255;

    public const int MaxServices = 200;

    public const int MaxAcknowledgments = 500;

    public const int MaxRiskIdLength = 600;

    public const int MaxSourceLength = 500;

    public const int MaxDescriptionLength = 500;

    public static bool IsStackName(string? name) => name is not null && StackName().IsMatch(name);

    public static bool IsServiceName(string? name) => name is { Length: > 0 and <= 255 } && ServiceName().IsMatch(name);

    public static bool IsEnvKey(string? key) => key is { Length: > 0 and <= MaxEnvKeyLength } && EnvKey().IsMatch(key);

    /// <summary>A finding id as the app's linter builds it: rule:service[:subject], printable text only.</summary>
    public static bool IsRiskId(string? id) =>
        id is { Length: > 0 and <= MaxRiskIdLength }
        && RiskId().IsMatch(id)
        && !id.Any(c => char.IsControl(c));

    /// <summary>Why the name cannot be used, or null when it can.</summary>
    public static string? StackNameProblem(string? name)
    {
        if (string.IsNullOrEmpty(name))
        {
            return "Enter a name for the app.";
        }

        if (name.Length > MaxNameLength)
        {
            return $"Keep the name to {MaxNameLength} characters or fewer.";
        }

        if (name.Any(char.IsAsciiLetterUpper))
        {
            return "Use lowercase letters. Compose project names can't have capitals.";
        }

        return IsStackName(name) ? null : "Use only lowercase letters, digits, dashes and underscores, starting with a letter or a digit.";
    }

    /// <summary>Go's path.Clean for `/`-separated paths, as Docker cleans them.</summary>
    public static string CleanPath(string path)
    {
        ArgumentNullException.ThrowIfNull(path);
        if (path.Length == 0)
        {
            return ".";
        }

        var rooted = path.StartsWith('/');
        var parts = new List<string>();
        foreach (var part in path.Split('/'))
        {
            if (part is "" or ".")
            {
                continue;
            }

            if (part == "..")
            {
                if (parts.Count > 0 && parts[^1] != "..")
                {
                    parts.RemoveAt(parts.Count - 1);
                }
                else if (!rooted)
                {
                    parts.Add("..");
                }

                continue;
            }

            parts.Add(part);
        }

        var joined = string.Join('/', parts);
        return rooted ? "/" + joined : joined.Length == 0 ? "." : joined;
    }

    /// <summary>Whether <paramref name="path"/> is <paramref name="folder"/> or inside it (both cleaned, absolute).</summary>
    public static bool Within(string path, string folder) =>
        path == folder || path.StartsWith(folder.EndsWith('/') ? folder : folder + "/", StringComparison.Ordinal);

    [GeneratedRegex("^[a-z0-9][a-z0-9_-]{0,62}$", RegexOptions.CultureInvariant)]
    private static partial Regex StackName();

    [GeneratedRegex("^[a-zA-Z0-9._-]+$", RegexOptions.CultureInvariant)]
    private static partial Regex ServiceName();

    [GeneratedRegex("^[A-Za-z_][A-Za-z0-9_.-]*$", RegexOptions.CultureInvariant)]
    private static partial Regex EnvKey();

    [GeneratedRegex("^[a-z][a-z-]*:", RegexOptions.CultureInvariant)]
    private static partial Regex RiskId();
}
