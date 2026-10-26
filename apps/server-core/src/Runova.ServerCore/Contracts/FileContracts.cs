using Tapper;

namespace Runova.ServerCore.Contracts;

// Files (E27): the file manager for a container's file system or a volume, Admin only. A session
// is opened on a target and lives on the core (not on the hub connection, which may be short), so
// the browse calls and the REST transfers (GET and PUT /api/v1/files/{SessionId}/content?path=)
// all name it. Paths are absolute and POSIX. A volume's root is "/", whatever folder the helper
// container mounts it at.

[TranspilationSource]
public enum FileTargetKind
{
    Container,
    Volume,
}

/// <summary>A container by id or name, or a volume by name.</summary>
[TranspilationSource]
public sealed record FileTarget(FileTargetKind Kind, string Id);

/// <summary>
/// What the session can do. Listing, stat, download, upload and new folders always work; the
/// rest needs a shell in a running container (volumes always have one, through the helper).
/// </summary>
/// <param name="AtomicUpload">Uploads land under a temporary name and are moved into place.</param>
[TranspilationSource]
public sealed record FileCapabilities(bool Rename, bool Remove, bool Chmod, bool AtomicUpload);

/// <param name="DisplayName">The container's name without the slash, or the volume's name.</param>
/// <param name="Home">Where the pane starts: the container's working folder, or "/" for a volume.</param>
/// <param name="User">Who the files are read and written as inside the container, such as root.</param>
/// <param name="Limitation">Why some actions are off, in a sentence the app shows; null when nothing is.</param>
[TranspilationSource]
public sealed record FileSessionInfo(
    Guid SessionId,
    FileTarget Target,
    string DisplayName,
    string Home,
    string User,
    FileCapabilities Capabilities,
    string? Limitation);

[TranspilationSource]
public enum FileEntryKind
{
    File,
    Directory,
    Symlink,
    Other,
}

/// <param name="Mode">The full st_mode, file type bits included.</param>
/// <param name="LinkTarget">For a link: where it points, as stored.</param>
/// <param name="LinkIsDirectory">For a link: true when it points at a folder.</param>
/// <param name="BrokenLink">For a link: true when nothing is at the other end.</param>
[TranspilationSource]
public sealed record FileEntry(
    string Name,
    FileEntryKind Kind,
    long Size,
    long? MtimeUnixMs,
    int Mode,
    int Uid,
    int Gid,
    string? LinkTarget = null,
    bool LinkIsDirectory = false,
    bool BrokenLink = false);

/// <param name="Partial">
/// Listed without a shell (a stopped or distroless container) and cut short: the folder was larger
/// than the core reads to list it.
/// </param>
[TranspilationSource]
public sealed record FileListing(string Path, FileEntry[] Entries, bool Partial);

[TranspilationSource]
public sealed record FilePathRequest(Guid SessionId, string Path);

[TranspilationSource]
public sealed record FileRenameRequest(Guid SessionId, string From, string To);

/// <summary>One entry: a file or link is unlinked, a folder removed only when empty.</summary>
[TranspilationSource]
public sealed record FileRemoveRequest(Guid SessionId, string Path, bool Directory);

/// <summary>Mode is the permission bits only (0 to 0o7777).</summary>
[TranspilationSource]
public sealed record FileChmodRequest(Guid SessionId, string Path, int Mode);
