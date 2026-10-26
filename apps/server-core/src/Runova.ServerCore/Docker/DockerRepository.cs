using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.Docker;

/// <summary>
/// Docker's own package repositories at download.docker.com and the fingerprints of their signing
/// keys, as Docker's install guides publish them. A downloaded key is only written to the system
/// when it is exactly the pinned one.
/// </summary>
internal static class DockerRepository
{
    /// <summary>Ubuntu and Debian ("9DC8 5822 9FC7 DD38 854A E2D8 8D81 803C 0EBF CD88").</summary>
    public const string DebianFingerprint = "9DC858229FC7DD38854AE2D88D81803C0EBFCD88";

    /// <summary>RHEL, CentOS, Rocky and Alma ("060A 61C5 1B55 8A7F 742B 77AA C52F EB6B 621E 9F35").</summary>
    public const string RhelFingerprint = "060A61C51B558A7F742B77AAC52FEB6B621E9F35";

    public const string AptKeyring = "/etc/apt/keyrings/docker.asc";

    public const string AptSource = "/etc/apt/sources.list.d/docker.sources";

    public const string RpmKey = "/etc/pki/rpm-gpg/docker-ce.asc";

    public const string RpmRepository = "/etc/yum.repos.d/docker-ce.repo";

    /// <summary>The first release with the `!override` tag the core's override files rely on.</summary>
    public static readonly Version MinimumCompose = new(2, 24, 4);

    public static readonly string[] Packages =
    [
        "docker-ce", "docker-ce-cli", "containerd.io", "docker-buildx-plugin", "docker-compose-plugin",
    ];

    /// <summary>What Docker's guides say to remove first: the distribution's own packages and podman's stack.</summary>
    public static IReadOnlyList<string> ConflictingPackages(OsFamily family) => family switch
    {
        OsFamily.Debian => ["docker.io", "docker-doc", "docker-compose", "docker-compose-v2", "podman-docker", "containerd", "runc"],
        OsFamily.Rhel =>
        [
            "docker", "docker-client", "docker-client-latest", "docker-common", "docker-latest",
            "docker-latest-logrotate", "docker-logrotate", "docker-engine", "podman", "buildah", "runc",
        ],
        _ => [],
    };

    /// <summary>Docker's directory for this distribution: ubuntu, debian, rhel, or centos for its rebuilds.</summary>
    public static string Distribution(OsInfo os)
    {
        ArgumentNullException.ThrowIfNull(os);
        return os.Family switch
        {
            OsFamily.Debian => os.Id == "debian" ? "debian" : "ubuntu",
            OsFamily.Rhel => os.Id == "rhel" ? "rhel" : "centos",
            _ => throw new ArgumentException("Docker's repositories cover the Debian and RHEL families.", nameof(os)),
        };
    }

    public static Uri KeyUrl(OsInfo os) => new($"https://download.docker.com/linux/{Distribution(os)}/gpg");

    public static string Fingerprint(OsFamily family) => family == OsFamily.Debian ? DebianFingerprint : RhelFingerprint;

    /// <summary>A deb822 source pinned to the key file.</summary>
    public static string AptSourceFor(OsInfo os, string codename, string architecture) => $"""
        # Written by Runova: Docker's own packages, signed by the key next to it.
        Types: deb
        URIs: https://download.docker.com/linux/{Distribution(os)}
        Suites: {codename}
        Components: stable
        Architectures: {architecture}
        Signed-By: {AptKeyring}

        """;

    public static string RpmRepositoryFor(OsInfo os) => $"""
        # Written by Runova: Docker's own packages, signed by the key it names.
        [docker-ce-stable]
        name=Docker CE Stable - $basearch
        baseurl=https://download.docker.com/linux/{Distribution(os)}/$releasever/$basearch/stable
        enabled=1
        gpgcheck=1
        gpgkey=file://{RpmKey}

        """;

    /// <summary>"2.39.4", "v2.39.4" or "2.24.4-desktop.1" to a version; null for anything else.</summary>
    public static Version? ParseComposeVersion(string? text)
    {
        var trimmed = text?.Trim().TrimStart('v') ?? string.Empty;
        var end = 0;
        while (end < trimmed.Length && (char.IsAsciiDigit(trimmed[end]) || trimmed[end] == '.'))
        {
            end++;
        }

        return Version.TryParse(trimmed[..end], out var version) && version.Build >= 0 ? version : null;
    }
}
