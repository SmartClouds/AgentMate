using System.Text.RegularExpressions;
using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.Platform;

/// <summary>
/// Package names as apt and dnf print them. Only names that pass this check ever reach a command
/// line, and none can start with a dash, so no name can be read as an option.
/// </summary>
internal static partial class PackageNames
{
    public static bool IsValid(string name) =>
        !string.IsNullOrEmpty(name) && name.Length <= 200 && Pattern().IsMatch(name);

    /// <summary>Debian and RPM names, with an optional `:arch` qualifier.</summary>
    [GeneratedRegex("^[A-Za-z0-9][A-Za-z0-9+._~-]*(?::[a-z0-9]+)?$", RegexOptions.CultureInvariant)]
    private static partial Regex Pattern();
}

/// <summary>`apt list --upgradable`: `name/suite[,suite] new-version arch [upgradable from: old]`.</summary>
internal static partial class AptOutput
{
    public static IReadOnlyList<UpgradablePackage> ParseUpgradable(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        var packages = new List<UpgradablePackage>();
        foreach (var raw in text.Split('\n'))
        {
            var match = Upgradable().Match(raw.TrimEnd('\r'));
            if (!match.Success || !PackageNames.IsValid(match.Groups["name"].Value))
            {
                continue;
            }

            var suites = match.Groups["suites"].Value;
            packages.Add(new UpgradablePackage(
                match.Groups["name"].Value,
                match.Groups["version"].Value,
                suites,
                // Ubuntu's noble-security, Debian's bookworm-security or (old)stable-security.
                Security: suites.Split(',').Any(suite => suite.EndsWith("-security", StringComparison.Ordinal)),
                Architecture: match.Groups["arch"].Value,
                CurrentVersion: match.Groups["old"].Success ? match.Groups["old"].Value : null));
        }

        return packages;
    }

    [GeneratedRegex(
        @"^(?<name>[^/\s]+)/(?<suites>\S+)\s+(?<version>\S+)\s+(?<arch>\S+)(?:\s+\[upgradable from:\s*(?<old>[^\]\s]+)\s*\])?\s*$",
        RegexOptions.CultureInvariant)]
    private static partial Regex Upgradable();
}

/// <summary>
/// `dnf check-update`: `name.arch  [epoch:]version-release  repository`. It exits 100 when there are
/// updates, 0 when there are none and 1 on an error. A name too long for its column is printed on a
/// line of its own with the rest on the next, and an "Obsoleting Packages" section may follow.
/// </summary>
internal static class DnfOutput
{
    private static readonly HashSet<string> _architectures = new(StringComparer.Ordinal)
    {
        "x86_64", "aarch64", "noarch", "i686", "i386", "s390x", "ppc64le", "armv7hl", "src",
    };

    public static IReadOnlyList<UpgradablePackage> ParseCheckUpdate(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        var packages = new List<UpgradablePackage>();
        (string Name, string Arch)? wrapped = null;
        foreach (var raw in text.Split('\n'))
        {
            var line = raw.TrimEnd('\r');
            if (line.StartsWith("Obsoleting Packages", StringComparison.Ordinal))
            {
                break;
            }

            var tokens = line.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
            if (tokens.Length == 0
                || line.StartsWith("Security:", StringComparison.Ordinal)
                || line.StartsWith("Last metadata expiration", StringComparison.Ordinal))
            {
                continue;
            }

            if (wrapped is { } pending)
            {
                wrapped = null;
                if (tokens.Length == 2 && char.IsWhiteSpace(line[0]))
                {
                    packages.Add(new UpgradablePackage(pending.Name, tokens[0], tokens[1], Security: false, pending.Arch));
                    continue;
                }
            }

            if (tokens.Length is 1 or 3 && SplitNameArch(tokens[0]) is { } nameArch)
            {
                if (tokens.Length == 1)
                {
                    wrapped = nameArch;
                }
                else
                {
                    packages.Add(new UpgradablePackage(nameArch.Name, tokens[1], tokens[2], Security: false, nameArch.Arch));
                }
            }
        }

        return packages;
    }

    /// <summary>Marks what `dnf check-update --security` also lists, by name and architecture.</summary>
    public static IReadOnlyList<UpgradablePackage> MarkSecurity(
        IReadOnlyList<UpgradablePackage> all,
        IReadOnlyList<UpgradablePackage> security)
    {
        ArgumentNullException.ThrowIfNull(all);
        ArgumentNullException.ThrowIfNull(security);
        var fixes = security.Select(package => (package.Name, package.Architecture)).ToHashSet();
        return [.. all.Select(package => package with { Security = fixes.Contains((package.Name, package.Architecture)) })];
    }

    /// <summary>`python3.11-libs.x86_64` is python3.11-libs for x86_64: the architecture is after the last dot.</summary>
    private static (string Name, string Arch)? SplitNameArch(string token)
    {
        var dot = token.LastIndexOf('.');
        if (dot <= 0)
        {
            return null;
        }

        var name = token[..dot];
        var arch = token[(dot + 1)..];
        return _architectures.Contains(arch) && PackageNames.IsValid(name) ? (name, arch) : null;
    }
}
