using System.Security.Cryptography;

namespace AgentMate.ServerCore.Backups.Destinations;

/// <summary>Paths on FTP and SFTP servers, which always use forward slashes, and the pins those servers are held to.</summary>
internal static class RemotePaths
{
    public static string Folder(string? path)
    {
        var trimmed = string.IsNullOrWhiteSpace(path) ? "/" : path.Trim();
        return trimmed.Length > 1 ? trimmed.TrimEnd('/') : trimmed;
    }

    public static string Join(string folder, string name) => folder == "/" ? "/" + name : folder + "/" + name;

    /// <summary>An SSH host key or a TLS certificate as the 64 hexadecimal characters the settings pin.</summary>
    public static string Fingerprint(byte[] key) => Convert.ToHexStringLower(SHA256.HashData(key));

    public static bool Matches(string? pinned, byte[] key) =>
        pinned is not null && CryptographicOperations.FixedTimeEquals(Convert.FromHexString(pinned), SHA256.HashData(key));

    /// <summary>Copies to a temporary file that deletes itself when closed, so a part can be read like a local one.</summary>
    public static FileStream TemporaryFile()
    {
        var options = new FileStreamOptions
        {
            Mode = FileMode.CreateNew,
            Access = FileAccess.ReadWrite,
            Share = FileShare.None,
            Options = FileOptions.Asynchronous | FileOptions.DeleteOnClose,
        };
        if (!OperatingSystem.IsWindows())
        {
            options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        }

        return new FileStream(Path.Combine(Path.GetTempPath(), $"agentmate-part-{Guid.NewGuid():N}"), options);
    }
}
