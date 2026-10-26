namespace Runova.ServerCore.Uploads;

/// <summary>
/// Caps for unpacking one upload. The defaults match the build-context limits the desktop app
/// checks before it packs a context (apps/desktop/src/main/deploy/stacks/buildContext.ts), so a
/// context the app agreed to send is never refused here for its size.
/// </summary>
internal sealed record TarExtractionLimits
{
    public static TarExtractionLimits Default { get; } = new();

    /// <summary>Bytes of file content once unpacked, with every hard link counted as a full copy.</summary>
    public long MaxTotalBytes { get; init; } = 256L * 1024 * 1024;

    /// <summary>Entries of any kind, folders and links included.</summary>
    public int MaxEntries { get; init; } = 50_000;

    /// <summary>Folders in one path, counting the file itself.</summary>
    public int MaxDepth { get; init; } = 64;

    /// <summary>UTF-8 bytes in one path, as Linux counts PATH_MAX.</summary>
    public int MaxPathBytes { get; init; } = 4096;
}

/// <summary>What an archive turned into on disk.</summary>
internal sealed record TarExtractionResult(int Files, int Directories, int Links, long Bytes);
