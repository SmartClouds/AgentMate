using AgentMate.ServerCore.Docker;

namespace AgentMate.ServerCore.Files;

/// <summary>
/// The helper container a volume is browsed through: the official busybox image pinned by its
/// multi-arch index digest (1.37, as `docker buildx imagetools inspect busybox:1.37` reported it
/// on 2026-10-22), no network, the volume at /data, and labels that find it again for the sweep
/// at start. It sleeps until removed; the files service runs everything in it as execs.
/// </summary>
internal static class VolumeHelpers
{
    public const string Label = "agentmate.files";

    public const string VolumeLabel = "agentmate.files.volume";

    public const string Digest = "sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e";

    public static readonly ImageReference Image = new("busybox", null, Digest);

    /// <summary>The longest sleep busybox takes in one number: about 68 years.</summary>
    private static readonly string[] _command = ["sleep", "2147483647"];

    public static HelperSpec For(string volume) =>
        new(
            Image,
            volume,
            FilePaths.VolumeRoot,
            new Dictionary<string, string>(StringComparer.Ordinal) { [Label] = "1", [VolumeLabel] = volume },
            _command);
}
