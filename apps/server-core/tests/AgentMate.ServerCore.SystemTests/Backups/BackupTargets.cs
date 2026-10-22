using System.Globalization;
using AgentMate.ServerCore.Backups.Destinations;
using AgentMate.ServerCore.Contracts;
using AgentMate.ServerCore.SystemTests.Acme;

namespace AgentMate.ServerCore.SystemTests.Backups;

/// <summary>
/// The backup-targets test server (test-servers/backup-targets): FTP with optional TLS and SFTP, one
/// user. Built and started once for every test that needs it; skipped without a Docker engine for
/// Linux containers, so it also runs on a desktop with Docker Desktop. FTP's passive ports are
/// published one to one, since vsftpd announces the container's own.
/// </summary>
public sealed class BackupTargets : IAsyncLifetime
{
    public const string User = "keeper";
    public const string Password = "keeper-test-pw";

    private static readonly TimeSpan _buildTimeout = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan _commandTimeout = TimeSpan.FromMinutes(1);
    private string? _container;

    public bool Available { get; private set; }

    public int FtpPort { get; private set; }

    public int SshPort { get; private set; }

    public string HostKeySha256 { get; private set; } = string.Empty;

    public async ValueTask InitializeAsync()
    {
        var cancel = TestContext.Current.CancellationToken;
        if (!await DockerCli.HasLinuxEngineAsync(cancel))
        {
            return;
        }

        var context = Path.Combine(RepositoryRoot(), "apps", "server-core", "test-servers", "backup-targets");
        await DockerCli.RunCheckedAsync(["build", "-q", "-t", "agentmate-backup-targets", context], _buildTimeout, cancel);
        _container = await DockerCli.RunCheckedAsync(
            ["run", "-d", "--rm", "-p", "127.0.0.1::21", "-p", "127.0.0.1::22", "-p", "127.0.0.1:30000-30009:30000-30009", "agentmate-backup-targets"],
            _commandTimeout,
            cancel);
        FtpPort = await PortAsync("21", cancel);
        SshPort = await PortAsync("22", cancel);
        for (var attempt = 0; attempt < 40 && HostKeySha256.Length == 0; attempt++)
        {
            HostKeySha256 = await SftpDestination.ProbeHostKeyAsync("127.0.0.1", SshPort, cancel) ?? string.Empty;
            if (HostKeySha256.Length == 0)
            {
                await Task.Delay(250, cancel);
            }
        }

        Available = HostKeySha256.Length > 0;
    }

    public async ValueTask DisposeAsync()
    {
        if (_container is not null)
        {
            await DockerCli.RunAsync(["rm", "-f", _container], _commandTimeout, CancellationToken.None);
        }
    }

    public void RequireAvailable() => Assert.SkipUnless(Available, "The backup destination system tests need a Docker engine for Linux containers.");

    public BackupDestinationSettings Ftp(string path, bool tls, string? pin = null) =>
        new(Path: path, Host: "127.0.0.1", Port: FtpPort, UserName: User, Tls: tls, HostKeySha256: pin);

    public BackupDestinationSettings Sftp(string path, string? pin = null) =>
        new(Path: path, Host: "127.0.0.1", Port: SshPort, UserName: User, HostKeySha256: pin ?? HostKeySha256);

    private async Task<int> PortAsync(string port, CancellationToken cancellationToken)
    {
        var mapped = await DockerCli.RunCheckedAsync(["port", _container!, port], _commandTimeout, cancellationToken);
        var first = mapped.Split('\n', StringSplitOptions.RemoveEmptyEntries)[0].Trim();
        return int.Parse(first[(first.LastIndexOf(':') + 1)..], CultureInfo.InvariantCulture);
    }

    private static string RepositoryRoot()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            if (File.Exists(Path.Combine(directory.FullName, "pnpm-workspace.yaml")))
            {
                return directory.FullName;
            }
        }

        throw new InvalidOperationException("The repository root was not found above the test binary.");
    }
}

[CollectionDefinition(Name)]
public sealed class BackupTargetsGroup : ICollectionFixture<BackupTargets>
{
    public const string Name = "backup targets";
}
