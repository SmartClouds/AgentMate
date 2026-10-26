using System.Globalization;
using System.Text.RegularExpressions;

namespace Runova.ServerCore.Nginx;

/// <summary>
/// Reads what nginx says about a configuration (nginx -t on standard error, or error.log after a
/// reload) and points each error at what the person wrote: a snippet line, a site, a stream proxy,
/// or nginx itself when it is about a file Runova does not write.
/// </summary>
internal static partial class NginxTestOutput
{
    public const string NginxField = "nginx";

    private const int MaxProblems = 20;
    private const int MaxMessage = 500;

    public static IReadOnlyList<NginxProblem> Problems(string output, NginxRelease release, NginxLayout layout)
    {
        ArgumentNullException.ThrowIfNull(output);
        ArgumentNullException.ThrowIfNull(release);
        ArgumentNullException.ThrowIfNull(layout);
        var problems = new List<NginxProblem>();
        foreach (var raw in output.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n'))
        {
            var match = ErrorLine().Match(raw.Trim());
            if (!match.Success || problems.Count >= MaxProblems)
            {
                continue;
            }

            var message = match.Groups["message"].Value;
            var located = Located().Match(message);
            var problem = located.Success && Map(located.Groups["path"].Value, layout, release) is { } file
                ? ToProblem(file, int.Parse(located.Groups["line"].Value, CultureInfo.InvariantCulture), Clip(message[..located.Index]))
                : new NginxProblem(NginxField, Clip(message));

            // nginx writes a bind() it retries once per try; one line says it.
            if (!problems.Contains(problem))
            {
                problems.Add(problem);
            }
        }

        if (problems.Count == 0)
        {
            var text = output.Trim();
            problems.Add(new NginxProblem(NginxField, text.Length == 0 ? "nginx refused the configuration without saying why." : Clip(text)));
        }

        return problems;
    }

    /// <summary>The site a problem's field is about ("sites[blog].serverSnippet" is about blog), if any.</summary>
    public static string? SiteIdOf(string field)
    {
        ArgumentNullException.ThrowIfNull(field);
        var match = SiteField().Match(field);
        return match.Success ? match.Groups["id"].Value : null;
    }

    private static NginxProblem ToProblem(NginxReleaseFile file, int line, string message)
    {
        if (file.SiteId is { } siteId && file.Snippet is { } snippet)
        {
            var name = snippet == NginxSnippetContext.Server ? "serverSnippet" : "locationSnippet";
            return new NginxProblem($"sites[{siteId}].{name}", message, line);
        }

        if (file.Path.StartsWith("sites/", StringComparison.Ordinal) || file.Path.StartsWith("auth/", StringComparison.Ordinal))
        {
            var id = Path.GetFileNameWithoutExtension(file.Path);
            return new NginxProblem($"sites[{id}]", message);
        }

        if (file.Path == NginxRenderer.StreamFile)
        {
            // The renderer starts each proxy with a "# Stream proxy <id>:" comment; the nearest one above the line owns it.
            var lines = file.Content.Split('\n');
            for (var i = Math.Min(line, lines.Length) - 1; i >= 0; i--)
            {
                var owner = StreamComment().Match(lines[i]);
                if (owner.Success)
                {
                    return new NginxProblem($"streams[{owner.Groups["id"].Value}]", message);
                }
            }
        }

        return new NginxProblem(NginxField, message);
    }

    /// <summary>The release file a path names, through the numbered directory or the current link.</summary>
    private static NginxReleaseFile? Map(string path, NginxLayout layout, NginxRelease release)
    {
        foreach (var prefix in new[] { release.Directory + "/", layout.CurrentLink + "/" })
        {
            if (path.StartsWith(prefix, StringComparison.Ordinal))
            {
                var relative = path[prefix.Length..];
                return release.Files.FirstOrDefault(file => file.Path == relative);
            }
        }

        return null;
    }

    private static string Clip(string text) => text.Length <= MaxMessage ? text : text[..(MaxMessage - 1)] + "…";

    /// <summary>"nginx: [emerg] ..." from nginx -t, or "2026/10/01 12:00:00 [emerg] 1#1: ..." from error.log.</summary>
    [GeneratedRegex(@"^(?:nginx: |\d{4}/\d\d/\d\d \d\d:\d\d:\d\d )\[(?:emerg|alert|crit|error)\] (?:\d+#\d+: (?:\*\d+ )?)?(?<message>.+)$", RegexOptions.CultureInvariant)]
    private static partial Regex ErrorLine();

    [GeneratedRegex(@" in (?<path>/[^\s:]+):(?<line>\d{1,7})$", RegexOptions.CultureInvariant)]
    private static partial Regex Located();

    [GeneratedRegex(@"^sites\[(?<id>[a-z0-9-]+)\]", RegexOptions.CultureInvariant)]
    private static partial Regex SiteField();

    [GeneratedRegex(@"^\s*# Stream proxy (?<id>[a-z0-9-]+):", RegexOptions.CultureInvariant)]
    private static partial Regex StreamComment();
}
