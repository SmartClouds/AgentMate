using System.Formats.Tar;
using System.Text;
using Runova.ServerCore.Backups;

namespace Runova.ServerCore.Tests.Backups;

/// <summary>Docker for backups, in memory: volumes hold files, images are saved as their ids.</summary>
internal sealed class FakeBackupDocker : IBackupDocker
{
    public bool Available { get; set; } = true;

    public Dictionary<string, (BackupVolume Volume, Dictionary<string, byte[]> Files)> Volumes { get; } = new(StringComparer.Ordinal);

    public List<BackupImage> Images { get; } = [];

    public List<BackupContainer> Containers { get; } = [];

    public List<string> Loaded { get; } = [];

    public List<BackupContainer> Recreated { get; } = [];

    public string? FailVolume { get; set; }

    public void AddVolume(string name, Dictionary<string, byte[]> files, string? project = null) =>
        Volumes[name] = (
            new BackupVolume(name, "local", project is null ? new Dictionary<string, string>() : new Dictionary<string, string> { ["com.docker.compose.project"] = project }),
            files);

    public Task<bool> IsAvailableAsync(CancellationToken cancellationToken) => Task.FromResult(Available);

    public Task<IReadOnlyList<BackupVolume>> ListVolumesAsync(CancellationToken cancellationToken) =>
        Task.FromResult<IReadOnlyList<BackupVolume>>([.. Volumes.Values.Select(v => v.Volume)]);

    public async Task ExportVolumeAsync(string volume, Stream output, CancellationToken cancellationToken)
    {
        if (volume == FailVolume)
        {
            throw new IOException("the helper container could not mount it");
        }

        await using var tar = new TarWriter(output, TarEntryFormat.Pax, leaveOpen: true);
        foreach (var (name, bytes) in Volumes[volume].Files)
        {
            await tar.WriteEntryAsync(new PaxTarEntry(TarEntryType.RegularFile, name) { DataStream = new MemoryStream(bytes) }, cancellationToken);
        }
    }

    public async Task ImportVolumeAsync(BackupVolume volume, Stream tar, CancellationToken cancellationToken)
    {
        var files = new Dictionary<string, byte[]>(StringComparer.Ordinal);
        await using var reader = new TarReader(tar, leaveOpen: true);
        while (await reader.GetNextEntryAsync(copyData: true, cancellationToken) is { } entry)
        {
            if (entry.DataStream is { } data)
            {
                var bytes = new MemoryStream();
                await data.CopyToAsync(bytes, cancellationToken);
                files[entry.Name] = bytes.ToArray();
            }
        }

        Volumes[volume.Name] = (volume, files);
    }

    public Task<IReadOnlyList<BackupImage>> ListImagesAsync(CancellationToken cancellationToken) =>
        Task.FromResult<IReadOnlyList<BackupImage>>(Images);

    public async Task SaveImagesAsync(IReadOnlyList<string> images, Stream output, CancellationToken cancellationToken) =>
        await output.WriteAsync(Encoding.UTF8.GetBytes(string.Join('\n', images)), cancellationToken);

    public async Task LoadImagesAsync(Stream tar, CancellationToken cancellationToken)
    {
        using var reader = new StreamReader(tar);
        Loaded.AddRange((await reader.ReadToEndAsync(cancellationToken)).Split('\n'));
    }

    public Task PullImageAsync(string reference, CancellationToken cancellationToken)
    {
        Loaded.Add("pulled:" + reference);
        return Task.CompletedTask;
    }

    public Task<IReadOnlyList<BackupContainer>> ListContainersAsync(CancellationToken cancellationToken) =>
        Task.FromResult<IReadOnlyList<BackupContainer>>(Containers);

    public Task RecreateContainerAsync(BackupContainer container, CancellationToken cancellationToken)
    {
        Recreated.Add(container);
        return Task.CompletedTask;
    }
}

/// <summary>The server's addresses and firewall, as a backup reads them.</summary>
internal sealed class FakeServerState : IServerStateReader
{
    public string[] Addresses { get; set; } = ["203.0.113.10", "2001:db8::10"];

    public FirewallRulesSnapshot? Firewall { get; set; }

    public Task<string[]> AddressesAsync(CancellationToken cancellationToken) => Task.FromResult(Addresses);

    public Task<FirewallRulesSnapshot?> FirewallAsync(CancellationToken cancellationToken) => Task.FromResult(Firewall);
}
