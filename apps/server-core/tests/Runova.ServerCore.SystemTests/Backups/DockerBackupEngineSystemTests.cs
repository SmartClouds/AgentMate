using System.Formats.Tar;
using Runova.ServerCore.Backups;
using Runova.ServerCore.SystemTests.Acme;

namespace Runova.ServerCore.SystemTests.Backups;

/// <summary>
/// The backup Docker engine against a real engine (Docker Desktop's pipe on Windows, the socket on
/// Linux): a volume read through the helper and written back exactly, hidden files and folders
/// included; an image built here saved and loaded; a standalone container created again.
/// </summary>
public sealed class DockerBackupEngineSystemTests : IAsyncLifetime
{
    private static readonly TimeSpan _timeout = TimeSpan.FromMinutes(3);
    private readonly string _suffix = Guid.NewGuid().ToString("N")[..8];
    private DockerBackupEngine? _engine;

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private DockerBackupEngine Engine => _engine ?? throw new InvalidOperationException();

    private string Source => $"e28-source-{_suffix}";

    private string Target => $"e28-target-{_suffix}";

    private string Built => $"e28-built-{_suffix}";

    private string Standalone => $"e28-standalone-{_suffix}";

    public async ValueTask InitializeAsync()
    {
        if (!await DockerCli.HasLinuxEngineAsync(Cancel))
        {
            return;
        }

        _engine = new DockerBackupEngine(new Uri(OperatingSystem.IsWindows() ? "npipe://./pipe/docker_engine" : "unix:///var/run/docker.sock"));
    }

    public async ValueTask DisposeAsync()
    {
        foreach (var command in new[]
        {
            new[] { "rm", "-f", Standalone },
            ["volume", "rm", "-f", Source],
            ["volume", "rm", "-f", Target],
            ["rmi", "-f", Built],
        })
        {
            await DockerCli.RunAsync(command, _timeout, CancellationToken.None);
        }

        _engine?.Dispose();
    }

    private void RequireEngine() => Assert.SkipUnless(_engine is not null, "Needs a Docker engine for Linux containers.");

    private static Task<string> DockerAsync(params string[] arguments) => DockerCli.RunCheckedAsync(arguments, _timeout, Cancel);

    [Fact]
    public async Task A_volume_comes_back_exactly_with_hidden_files_and_folders()
    {
        RequireEngine();
        await DockerAsync("volume", "create", Source);
        await DockerAsync("run", "--rm", "-v", $"{Source}:/d", DockerBackupEngine.HelperImage, "sh", "-c", "echo hello > /d/a.txt && mkdir -p /d/sub && echo secret > /d/sub/.hidden");
        await DockerAsync("volume", "create", Target);
        await DockerAsync("run", "--rm", "-v", $"{Target}:/d", DockerBackupEngine.HelperImage, "sh", "-c", "echo stale > /d/old.txt");

        var tar = new MemoryStream();
        await Engine.ExportVolumeAsync(Source, tar, Cancel);
        tar.Position = 0;
        var names = new List<string>();
        await using (var reader = new TarReader(new MemoryStream(tar.ToArray())))
        {
            while (await reader.GetNextEntryAsync(cancellationToken: Cancel) is { } entry)
            {
                names.Add(entry.Name);
            }
        }

        await Engine.ImportVolumeAsync(new BackupVolume(Target, "local", new Dictionary<string, string>()), tar, Cancel);
        var listing = await DockerAsync("run", "--rm", "-v", $"{Target}:/d", DockerBackupEngine.HelperImage, "sh", "-c", "cd /d && find . -type f | sort && cat sub/.hidden");

        Assert.Contains(names, name => name.EndsWith("a.txt", StringComparison.Ordinal));
        Assert.Equal("./a.txt\n./sub/.hidden\nsecret", listing.Replace("\r", string.Empty, StringComparison.Ordinal));
        Assert.Empty(await DockerAsync("ps", "-a", "--filter", "label=" + DockerBackupEngine.HelperLabel, "-q"));
    }

    [Fact]
    public async Task A_volume_that_is_missing_is_made_on_restore()
    {
        RequireEngine();
        await DockerAsync("volume", "create", Source);
        await DockerAsync("run", "--rm", "-v", $"{Source}:/d", DockerBackupEngine.HelperImage, "sh", "-c", "echo one > /d/one");
        var tar = new MemoryStream();
        await Engine.ExportVolumeAsync(Source, tar, Cancel);
        tar.Position = 0;

        await Engine.ImportVolumeAsync(new BackupVolume(Target, "local", new Dictionary<string, string> { ["com.docker.compose.project"] = "shop" }), tar, Cancel);

        Assert.Equal("shop", await DockerAsync("volume", "inspect", Target, "--format", "{{index .Labels \"com.docker.compose.project\"}}"));
        Assert.Equal("one", await DockerAsync("run", "--rm", "-v", $"{Target}:/d", DockerBackupEngine.HelperImage, "cat", "/d/one"));
    }

    [Fact]
    public async Task An_image_built_here_survives_save_and_load()
    {
        RequireEngine();
        var context = Directory.CreateTempSubdirectory("e28-image-").FullName;
        await File.WriteAllTextAsync(Path.Combine(context, "Dockerfile"), $"FROM {DockerBackupEngine.HelperImage}\nRUN echo built > /built\n", Cancel);
        await DockerAsync("build", "-q", "-t", Built, context);

        var image = Assert.Single(await Engine.ListImagesAsync(Cancel), i => i.Tags.Contains(Built + ":latest"));
        var saved = new MemoryStream();
        await Engine.SaveImagesAsync(image.Tags, saved, Cancel);
        await DockerAsync("rmi", "-f", Built);
        saved.Position = 0;
        await Engine.LoadImagesAsync(saved, Cancel);

        Assert.Equal(image.Id, await DockerAsync("image", "inspect", Built, "--format", "{{.Id}}"));
        Directory.Delete(context, recursive: true);
    }

    [Fact]
    public async Task A_container_started_by_hand_is_created_again_with_its_ports_and_restart_policy()
    {
        RequireEngine();
        await DockerAsync("run", "-d", "--name", Standalone, "--restart", "unless-stopped", "-e", "GREETING=hi", "-p", "127.0.0.1:18089:80", DockerBackupEngine.HelperImage, "sleep", "300");

        var listed = Assert.Single(await Engine.ListContainersAsync(Cancel), c => c.Name == Standalone);
        await DockerAsync("rm", "-f", Standalone);
        await Engine.RecreateContainerAsync(listed, Cancel);

        Assert.Null(listed.ComposeProject);
        Assert.True(listed.Running);
        Assert.Contains("GREETING=hi", listed.Spec.Env);
        Assert.Equal("unlessstopped", listed.Spec.RestartPolicy);
        var port = Assert.Single(listed.Spec.Ports);
        Assert.Equal(("80/tcp", "18089"), (port.ContainerPort, port.HostPort));
        Assert.Equal("true unless-stopped 18089", await DockerAsync(
            "inspect", Standalone, "--format", "{{.State.Running}} {{.HostConfig.RestartPolicy.Name}} {{(index (index .HostConfig.PortBindings \"80/tcp\") 0).HostPort}}"));
    }
}
