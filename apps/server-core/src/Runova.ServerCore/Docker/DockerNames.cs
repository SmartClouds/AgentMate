using System.Text.RegularExpressions;

namespace Runova.ServerCore.Docker;

/// <summary>
/// Checks every name the app sends before it reaches the engine. The Docker client puts ids and
/// names into request paths as they are, so a slash, a question mark or a percent sign would reach
/// another endpoint; nothing outside these patterns gets that far.
/// </summary>
internal static partial class DockerNames
{
    /// <summary>The signals a container may be sent from the app.</summary>
    public static readonly IReadOnlySet<string> Signals = new HashSet<string>(StringComparer.Ordinal)
    {
        "SIGKILL", "SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT", "SIGUSR1", "SIGUSR2",
    };

    /// <summary>A container id (or its prefix) or name, as Docker allows them.</summary>
    public static bool IsContainer(string? value) => value is { Length: > 0 and <= 128 } && ObjectName().IsMatch(value);

    /// <summary>Volumes and networks follow the same rule as container names.</summary>
    public static bool IsVolume(string? value) => IsContainer(value);

    public static bool IsNetwork(string? value) => IsContainer(value);

    /// <summary>An image id (sha256:..., or its short form) or a reference.</summary>
    public static bool IsImage(string? value) =>
        value is { Length: > 0 and <= 255 } && (ImageId().IsMatch(value) || TryParseReference(value, out _));

    /// <summary>A user for docker exec: a name or uid, optionally with a group.</summary>
    public static bool IsUser(string? value) => value is { Length: > 0 and <= 64 } && User().IsMatch(value);

    /// <summary>
    /// A pullable reference: [registry[:port]/]path[:tag][@sha256:digest]. Without a tag the pull
    /// asks for latest; the engine would otherwise pull every tag of the repository.
    /// </summary>
    public static bool TryParseReference(string? value, out ImageReference reference)
    {
        reference = new ImageReference(string.Empty, null, null);
        if (value is not { Length: > 0 and <= 255 })
        {
            return false;
        }

        var match = Reference().Match(value);
        if (!match.Success)
        {
            return false;
        }

        var repository = match.Groups["repository"].Value;
        var tag = match.Groups["tag"].Success ? match.Groups["tag"].Value : null;
        var digest = match.Groups["digest"].Success ? match.Groups["digest"].Value : null;
        reference = new ImageReference(repository, digest is null ? tag ?? "latest" : tag, digest);
        return true;
    }

    [GeneratedRegex("^[a-zA-Z0-9][a-zA-Z0-9_.-]*$", RegexOptions.CultureInvariant)]
    private static partial Regex ObjectName();

    [GeneratedRegex("^(?:sha256:)?[a-f0-9]{12,64}$", RegexOptions.CultureInvariant)]
    private static partial Regex ImageId();

    [GeneratedRegex("^[a-z_][a-z0-9_.-]*(?::[a-z_0-9][a-z0-9_.-]*)?$|^[0-9]+(?::[0-9]+)?$", RegexOptions.CultureInvariant)]
    private static partial Regex User();

    [GeneratedRegex(
        @"^(?<repository>(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?(?::[0-9]{1,5})?/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*)(?::(?<tag>[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}))?(?:@(?<digest>sha256:[a-f0-9]{64}))?$",
        RegexOptions.CultureInvariant)]
    private static partial Regex Reference();
}
