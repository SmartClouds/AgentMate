using System.Diagnostics.CodeAnalysis;
using System.Text;

namespace AgentMate.ServerCore.Files;

/// <summary>
/// The path rules for the file manager. The app sends absolute POSIX paths; each is normalized
/// before anything uses it: empty and "." segments go, ".." takes the previous segment off and
/// stops at "/", and a NUL anywhere refuses it. A volume is shown from "/" but lives under
/// <see cref="VolumeRoot"/> in its helper container, and because the mapping only ever prefixes a
/// normalized path (which has no ".." left), no path the app sends can name anything above it.
/// </summary>
internal static class FilePaths
{
    /// <summary>PATH_MAX on Linux.</summary>
    public const int MaxLength = 4096;

    /// <summary>NAME_MAX on Linux, in bytes.</summary>
    public const int MaxNameBytes = 255;

    /// <summary>Where a helper container mounts the volume it serves.</summary>
    public const string VolumeRoot = "/data";

    /// <summary>A container's own files: paths are what they are inside it.</summary>
    public const string ContainerRoot = "";

    public static bool TryNormalize(string? path, [NotNullWhen(true)] out string? normalized)
    {
        normalized = null;
        if (string.IsNullOrEmpty(path) || path[0] != '/' || path.Length > MaxLength || path.Contains('\0', StringComparison.Ordinal))
        {
            return false;
        }

        var segments = new List<string>();
        foreach (var segment in path.Split('/'))
        {
            switch (segment)
            {
                case "" or ".":
                    break;
                case "..":
                    if (segments.Count > 0)
                    {
                        segments.RemoveAt(segments.Count - 1);
                    }

                    break;
                default:
                    segments.Add(segment);
                    break;
            }
        }

        normalized = "/" + string.Join('/', segments);
        return true;
    }

    /// <summary>The normalized path, or an invalidInput refusal the app can show.</summary>
    public static string Normalize(string? path) =>
        TryNormalize(path, out var normalized)
            ? normalized
            : throw new FileOperationException(
                FileErrorCode.InvalidInput,
                path is { Length: > MaxLength }
                    ? $"That path is longer than {MaxLength} characters."
                    : "That is not an absolute path (it starts with /, and has no NUL in it).");

    /// <summary>The folder a normalized path is in; "/" for "/" itself.</summary>
    public static string Parent(string path)
    {
        ArgumentNullException.ThrowIfNull(path);
        var slash = path.LastIndexOf('/');
        return slash <= 0 ? "/" : path[..slash];
    }

    /// <summary>The last segment of a normalized path; empty for "/".</summary>
    public static string Name(string path)
    {
        ArgumentNullException.ThrowIfNull(path);
        return path[(path.LastIndexOf('/') + 1)..];
    }

    public static string Combine(string folder, string name)
    {
        ArgumentNullException.ThrowIfNull(folder);
        return folder == "/" ? "/" + name : $"{folder}/{name}";
    }

    /// <summary>One segment: not empty, not "." or "..", no slash or NUL, at most 255 bytes.</summary>
    public static bool IsValidName(string? name) =>
        !string.IsNullOrEmpty(name)
        && name is not ("." or "..")
        && name.IndexOfAny(['/', '\0']) < 0
        && Encoding.UTF8.GetByteCount(name) <= MaxNameBytes;

    /// <summary>Where a normalized path is in the container that serves it.</summary>
    public static string Inside(string path, string root)
    {
        ArgumentNullException.ThrowIfNull(root);
        if (!TryNormalize(path, out var normalized) || normalized != path)
        {
            throw new ArgumentException("Only a normalized path can be mapped.", nameof(path));
        }

        return root.Length == 0 ? path : path == "/" ? root : root + path;
    }

    /// <summary>The path the app shows for one inside the serving container, or null when it is outside the root.</summary>
    public static string? Outside(string inside, string root)
    {
        ArgumentNullException.ThrowIfNull(root);
        if (!TryNormalize(inside, out var normalized))
        {
            return null;
        }

        if (root.Length == 0)
        {
            return normalized;
        }

        if (normalized == root)
        {
            return "/";
        }

        return normalized.StartsWith(root + "/", StringComparison.Ordinal) ? normalized[root.Length..] : null;
    }
}
