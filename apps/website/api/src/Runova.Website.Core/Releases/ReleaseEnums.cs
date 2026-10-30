namespace Runova.Website.Core.Releases;

// The numbers are what the database stores, so they never change; JSON and query strings use the
// names (see ApiEnums).

/// <summary>The operating system a desktop asset installs on.</summary>
public enum ReleasePlatform
{
    Windows = 0,
    Macos = 1,
    Linux = 2,
}

/// <summary>The processor a desktop asset is built for. A universal asset runs on both.</summary>
public enum ReleaseArch
{
    X64 = 0,
    Arm64 = 1,
    Universal = 2,
}

/// <summary>The kind of file: an installer, a disk image or an archive.</summary>
public enum ReleaseKind
{
    Nsis = 0,
    Dmg = 1,
    Zip = 2,
    Appimage = 3,
    Deb = 4,
}
