using Tapper;

namespace Runova.ServerCore.Contracts;

/// <summary>
/// A server core release for the core to switch to, as the app's own release manifest describes
/// it. The checksum and size come from the app, never from where the file is fetched, so a core
/// that downloads its release trusts it no more than one the app uploads.
/// </summary>
/// <param name="Version">The release's version, such as 1.63.0.</param>
/// <param name="File">The tarball's name: runova-core-&lt;version&gt;-&lt;rid&gt;.tar.gz for this server's processor (a server not yet moved to the Runova layout also takes the name from before the rename).</param>
/// <param name="Sha256">The tarball's SHA-256, lowercase hex.</param>
/// <param name="Size">The tarball's size in bytes.</param>
/// <param name="DownloadUrl">The GitHub release asset to fetch it from. Left out when the app uploads it.</param>
[TranspilationSource]
public sealed record CoreUpdateRequest(string Version, string File, string Sha256, long Size, string? DownloadUrl = null);

/// <summary>How a core update went, as far as the core could take it.</summary>
[TranspilationSource]
public enum CoreUpdateOutcome
{
    /// <summary>The release checked out and is unpacked; a moment from now the server switches to it and restarts the core.</summary>
    Switching,

    /// <summary>The core could not fetch the release itself (no route to GitHub, or what came was not the release). The app can upload it instead.</summary>
    DownloadFailed,

    /// <summary>This core cannot replace itself: the app did not install it (the DevHost, a development run). Update it over SSH instead.</summary>
    Unsupported,
}

/// <param name="Outcome">What happened.</param>
/// <param name="RunningVersion">The core that answered, which runs until the switch.</param>
/// <param name="Problem">Why the download failed or the core cannot update itself, in words for the user.</param>
[TranspilationSource]
public sealed record CoreUpdateResult(CoreUpdateOutcome Outcome, string RunningVersion, string? Problem = null);
