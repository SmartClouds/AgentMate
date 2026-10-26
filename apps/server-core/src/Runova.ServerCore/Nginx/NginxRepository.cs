using System.Globalization;

namespace Runova.ServerCore.Nginx;

/// <summary>
/// nginx.org's stable package repository, the same on both OS families: its signing key (trusted
/// only with exactly the fingerprints nginx.org publishes) and the files that point apt or dnf at it.
/// </summary>
internal static class NginxRepository
{
    public const string SigningKeyUrl = "https://nginx.org/keys/nginx_signing.key";

    public const string DebianKeyringPath = "/usr/share/keyrings/nginx-archive-keyring.gpg";

    public const string DebianSourcesPath = "/etc/apt/sources.list.d/nginx.list";

    public const string DebianPinPath = "/etc/apt/preferences.d/99nginx";

    public const string RhelKeyPath = "/etc/pki/rpm-gpg/RPM-GPG-KEY-nginx";

    public const string RhelRepoPath = "/etc/yum.repos.d/nginx.repo";

    /// <summary>Older versions do not understand <c>http2 on;</c>, which the sites use.</summary>
    public static readonly Version MinimumVersion = new(1, 25, 1);

    /// <summary>From https://nginx.org/en/linux_packages.html, as the harness images check them too.</summary>
    public static readonly IReadOnlyList<string> SigningKeyFingerprints =
    [
        "573BFD6B3D8FBC641079A6ABABF5BD827BD9BF62",
        "8540A6F18833A80E9C1653A42FD21310B49F6B46",
        "9E9BE90EACBCDE69FE9B204CBCDCD8A38D88A2B3",
    ];

    /// <summary>
    /// Null when the armored key holds exactly the published primary keys; otherwise why not.
    /// <paramref name="keyring"/> is then the binary keyring to install.
    /// </summary>
    public static string? CheckSigningKey(string armored, out byte[] keyring)
    {
        keyring = [];
        try
        {
            var binary = OpenPgpKeys.Dearmor(armored);
            var found = OpenPgpKeys.PrimaryFingerprints(binary).Order(StringComparer.Ordinal).ToList();
            if (!found.SequenceEqual(SigningKeyFingerprints.Order(StringComparer.Ordinal)))
            {
                return $"nginx.org's signing key has the fingerprints {string.Join(", ", found)}, not the published {string.Join(", ", SigningKeyFingerprints)}; it was not trusted.";
            }

            keyring = binary;
            return null;
        }
        catch (OpenPgpFormatException error)
        {
            return $"nginx.org's signing key could not be read: {error.Message}";
        }
    }

    /// <summary>The apt source for Ubuntu or Debian (<paramref name="distribution"/> is os-release's ID).</summary>
    public static string DebianSources(string distribution, string codename) =>
        $"# Written by Runova: nginx stable from nginx.org.\ndeb [signed-by={DebianKeyringPath}] https://nginx.org/packages/{distribution} {codename} nginx\n";

    /// <summary>nginx.org's packages win over the distribution's, as nginx.org's instructions set it up.</summary>
    public const string DebianPin =
        "# Written by Runova: prefer nginx.org's nginx over the distribution's.\nPackage: *\nPin: origin nginx.org\nPin: release o=nginx\nPin-Priority: 900\n";

    /// <summary>The dnf repository for RHEL and its rebuilds; nginx.org publishes them under centos/.</summary>
    public static string RhelRepo(int majorVersion) =>
        string.Create(
            CultureInfo.InvariantCulture,
            $"# Written by Runova: nginx stable from nginx.org.\n[nginx-stable]\nname=nginx stable repo\nbaseurl=https://nginx.org/packages/centos/{majorVersion}/$basearch/\ngpgcheck=1\nenabled=1\ngpgkey=file://{RhelKeyPath}\nmodule_hotfixes=true\n");

    /// <summary>"nginx version: nginx/1.30.0" (nginx -v writes it to standard error).</summary>
    public static Version? ParseVersion(string output)
    {
        ArgumentNullException.ThrowIfNull(output);
        var marker = output.IndexOf("nginx/", StringComparison.Ordinal);
        if (marker < 0)
        {
            return null;
        }

        var text = new string([.. output[(marker + 6)..].TakeWhile(c => char.IsAsciiDigit(c) || c == '.')]);
        return Version.TryParse(text, out var version) ? version : null;
    }
}
