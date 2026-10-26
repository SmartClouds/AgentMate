using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Runova.ServerCore.Registries;

namespace Runova.ServerCore.Tests.Registries;

public sealed class RegistryAuthFoldersTests : IDisposable
{
    private const string Secret = "ghp_registryfolderstest0123456789abcdef";

    private readonly string _root = Path.Combine(Path.GetTempPath(), $"registry-auth-{Guid.NewGuid():N}");

    private RegistryAuthFolders Folders(bool requireMemory = false, string? mounts = null) =>
        new(_root, requireMemory, () => mounts, NullLogger<RegistryAuthFolders>.Instance);

    private static readonly RegistryLogin[] _logins =
    [
        new("ghcr.io", "octocat", Secret, RegistryLoginSource.Request),
        new("docker.io", "hubber", "dckr_pat_hubsecret0123456789abcdef", RegistryLoginSource.Stored),
    ];

    [Fact]
    public void A_job_gets_a_docker_config_of_its_own_that_the_cli_can_read()
    {
        var folders = Folders();
        var jobId = Guid.NewGuid();

        string directory;
        using (var lease = folders.Create(jobId, _logins))
        {
            directory = lease.Directory;
            Assert.Equal(Path.Combine(_root, jobId.ToString("N")), directory);
            Assert.Equal(directory, lease.Environment["DOCKER_CONFIG"]);
            using var config = JsonDocument.Parse(File.ReadAllText(Path.Combine(directory, "config.json")));
            var auths = config.RootElement.GetProperty("auths");
            var github = Encoding.UTF8.GetString(Convert.FromBase64String(auths.GetProperty("ghcr.io").GetProperty("auth").GetString()!));
            Assert.Equal($"octocat:{Secret}", github);
            Assert.True(auths.TryGetProperty("https://index.docker.io/v1/", out _));
            if (!OperatingSystem.IsWindows())
            {
                Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute, File.GetUnixFileMode(directory));
                Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(Path.Combine(directory, "config.json")));
            }
        }

        Assert.False(Directory.Exists(directory));
        Assert.Empty(Directory.EnumerateFileSystemEntries(_root));
    }

    [Fact]
    public void Without_a_memory_filesystem_nothing_is_written_where_it_is_required()
    {
        var mounts = "22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw\n";
        var folders = Folders(requireMemory: true, mounts: mounts);

        var refused = Assert.Throws<RegistryAuthUnavailableException>(() => folders.Create(Guid.NewGuid(), _logins));

        Assert.Contains("memory", refused.Message, StringComparison.OrdinalIgnoreCase);
        Assert.False(Directory.Exists(_root) && Directory.EnumerateFileSystemEntries(_root).Any());
    }

    [Fact]
    public void On_tmpfs_it_writes()
    {
        var mounts = $"22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw\n30 22 0:25 / {_root.Replace('\\', '/')} rw,nosuid,nodev - tmpfs tmpfs rw,mode=755\n";
        var folders = Folders(requireMemory: true, mounts: mounts);
        if (OperatingSystem.IsWindows())
        {
            // The mount table speaks Linux paths; the parse is what this checks on Windows.
            Assert.Equal("tmpfs", MountTable.FileSystemOf(_root.Replace('\\', '/'), mounts));
            return;
        }

        using var lease = folders.Create(Guid.NewGuid(), _logins);
        Assert.True(File.Exists(Path.Combine(lease.Directory, "config.json")));
    }

    [Fact]
    public void A_sweep_removes_what_a_stopped_core_left()
    {
        var folders = Folders();
        var leftover = Path.Combine(_root, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(leftover);
        File.WriteAllText(Path.Combine(leftover, "config.json"), Secret);

        Assert.Equal(1, folders.Sweep());
        Assert.False(Directory.Exists(leftover));
    }

    [Theory]
    [InlineData("/run/runova-core/registry-auth", "tmpfs")]
    [InlineData("/run", "tmpfs")]
    [InlineData("/var/lib/runova-core", "ext4")]
    [InlineData("/runner", "ext4")]
    public void The_mount_table_names_the_filesystem_a_path_is_on(string path, string expected)
    {
        const string Mounts = """
            22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw
            25 22 0:23 / /run rw,nosuid,nodev,noexec,relatime shared:5 - tmpfs tmpfs rw,size=401060k,mode=755
            26 22 0:24 / /proc rw,nosuid,nodev,noexec,relatime shared:12 - proc proc rw
            """;
        Assert.Equal(expected, MountTable.FileSystemOf(path, Mounts));
    }

    [Fact]
    public void Escaped_mount_points_are_read_back()
    {
        const string Mounts = "22 1 8:1 / / rw - ext4 /dev/sda1 rw\n31 22 0:30 / /mnt/with\\040space rw - tmpfs tmpfs rw\n";
        Assert.Equal("tmpfs", MountTable.FileSystemOf("/mnt/with space/x", Mounts));
    }

    public void Dispose() => TestFolders.Delete(_root);
}
