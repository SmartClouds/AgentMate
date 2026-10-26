using Tapper;

namespace Runova.ServerCore.Contracts;

/// <summary>A package with a newer version waiting. The current version is unknown on dnf.</summary>
[TranspilationSource]
public sealed record UpgradablePackage(
    string Name,
    string NewVersion,
    string Source,
    bool Security,
    string? Architecture = null,
    string? CurrentVersion = null);

/// <summary>unattended-upgrades on the Debian family, dnf-automatic on the RHEL family.</summary>
[TranspilationSource]
public sealed record AutoUpdatesInfo(bool Supported, bool Installed, bool Enabled, string Mechanism);

/// <summary>
/// What is waiting to be upgraded, as of the last check (null before the first). The list comes
/// from a cache the core refreshes by itself; CheckForUpdates refreshes the package index first.
/// </summary>
[TranspilationSource]
public sealed record UpdatesInfo(
    string PackageManager,
    UpgradablePackage[] Packages,
    int SecurityCount,
    AutoUpdatesInfo AutomaticSecurityUpdates,
    long? CheckedAtUnixMs = null,
    bool? RebootRequired = null,
    string? Error = null);
