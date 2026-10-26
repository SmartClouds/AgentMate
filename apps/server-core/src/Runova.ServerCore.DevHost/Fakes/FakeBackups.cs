using System.Collections.Concurrent;
using System.Formats.Tar;
using System.Text;
using Runova.ServerCore.Backups;
using Runova.ServerCore.Backups.Destinations;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Docker;

namespace Runova.ServerCore.DevHost.Fakes;

/// <summary>
/// Server backups on the DevHost (E28): Docker as the pretend engine shows it (each volume holds a
/// small file naming it), destinations of every kind kept in memory, and a Telegram account that
/// takes the code 12345 (and the cloud password "devhost" for +10000000002).
/// </summary>
internal static class FakeBackups
{
    public static void Add(IServiceCollection services)
    {
        services.AddSingleton<IBackupDocker, PretendBackupDocker>();
        services.AddSingleton<IBackupDestinationFactory, MemoryDestinations>();
        services.AddSingleton<ITelegramConnector, PretendTelegram>();
    }
}

internal sealed class PretendBackupDocker(InMemoryDockerEngine engine) : IBackupDocker
{
    private readonly ConcurrentDictionary<string, byte[]> _restored = new(StringComparer.Ordinal);

    public Task<bool> IsAvailableAsync(CancellationToken cancellationToken) => Task.FromResult(true);

    public async Task<IReadOnlyList<BackupVolume>> ListVolumesAsync(CancellationToken cancellationToken) =>
        [.. (await engine.ListVolumesAsync(cancellationToken)).Select(volume => new BackupVolume(
            volume.Name,
            volume.Driver,
            volume.ComposeProject is null ? new Dictionary<string, string>() : new Dictionary<string, string> { ["com.docker.compose.project"] = volume.ComposeProject }))];

    public async Task ExportVolumeAsync(string volume, Stream output, CancellationToken cancellationToken)
    {
        await using var tar = new TarWriter(output, TarEntryFormat.Pax, leaveOpen: true);
        var contents = _restored.TryGetValue(volume, out var restored) ? restored : Encoding.UTF8.GetBytes($"The {volume} volume on the DevHost.\n");
        await tar.WriteEntryAsync(new PaxTarEntry(TarEntryType.RegularFile, "README") { DataStream = new MemoryStream(contents) }, cancellationToken);
    }

    public async Task ImportVolumeAsync(BackupVolume volume, Stream tar, CancellationToken cancellationToken)
    {
        await using var reader = new TarReader(tar, leaveOpen: true);
        while (await reader.GetNextEntryAsync(copyData: true, cancellationToken) is { } entry)
        {
            if (entry.DataStream is { } data)
            {
                var bytes = new MemoryStream();
                await data.CopyToAsync(bytes, cancellationToken);
                _restored[volume.Name] = bytes.ToArray();
            }
        }
    }

    public async Task<IReadOnlyList<BackupImage>> ListImagesAsync(CancellationToken cancellationToken) =>
        [.. (await engine.ListImagesAsync(cancellationToken)).Select(image => new BackupImage(image.Id, image.Tags, image.Digests))];

    public async Task SaveImagesAsync(IReadOnlyList<string> images, Stream output, CancellationToken cancellationToken) =>
        await output.WriteAsync(Encoding.UTF8.GetBytes(string.Join('\n', images)), cancellationToken);

    public Task LoadImagesAsync(Stream tar, CancellationToken cancellationToken) => Task.CompletedTask;

    public Task PullImageAsync(string reference, CancellationToken cancellationToken) => Task.CompletedTask;

    public async Task<IReadOnlyList<BackupContainer>> ListContainersAsync(CancellationToken cancellationToken) =>
        [.. (await engine.ListContainersAsync(cancellationToken)).Select(container => new BackupContainer(
            container.Summary.Name,
            container.Summary.Image,
            container.Summary.ComposeProject,
            container.Summary.State == ContainerState.Running,
            new ContainerSpec([], null, null, null, null, [], [], [], null, null)))];

    public Task RecreateContainerAsync(BackupContainer container, CancellationToken cancellationToken) => Task.CompletedTask;
}

/// <summary>Every destination in memory, by id; one whose name contains "offline" refuses everything.</summary>
internal sealed class MemoryDestinations : IBackupDestinationFactory
{
    private readonly ConcurrentDictionary<Guid, MemoryFiles> _stores = new();

    public Task<IBackupDestination> OpenAsync(ResolvedDestination destination, CancellationToken cancellationToken)
    {
        var files = _stores.GetOrAdd(destination.Id, _ => new MemoryFiles());
        files.Offline = destination.Name.Contains("offline", StringComparison.OrdinalIgnoreCase);
        return Task.FromResult<IBackupDestination>(new CloudDriveDestination(files, destination.Name));
    }

    private sealed class MemoryFiles : ICloudFiles
    {
        private readonly ConcurrentDictionary<string, CloudFile> _files = new(StringComparer.Ordinal);
        private readonly ConcurrentDictionary<string, byte[]> _bytes = new(StringComparer.Ordinal);

        public bool Offline { get; set; }

        public Task<IReadOnlyList<CloudFile>> ListAsync(CancellationToken cancellationToken) =>
            Offline ? throw Refused() : Task.FromResult<IReadOnlyList<CloudFile>>([.. _files.Values]);

        public async Task PutAsync(string name, Stream content, long length, IProgress<long>? progress, CancellationToken cancellationToken)
        {
            if (Offline)
            {
                throw Refused();
            }

            var bytes = new MemoryStream();
            await content.CopyToAsync(bytes, cancellationToken);
            progress?.Report(bytes.Length);
            var id = Guid.NewGuid().ToString("N");
            foreach (var same in _files.Values.Where(file => file.Name == name).ToList())
            {
                _files.TryRemove(same.Id, out _);
                _bytes.TryRemove(same.Id, out _);
            }

            _files[id] = new CloudFile(id, name, bytes.Length);
            _bytes[id] = bytes.ToArray();
        }

        public Task<Stream> OpenAsync(CloudFile file, CancellationToken cancellationToken) => Task.FromResult<Stream>(new MemoryStream(_bytes[file.Id]));

        public Task DeleteAsync(CloudFile file, CancellationToken cancellationToken)
        {
            _files.TryRemove(file.Id, out _);
            _bytes.TryRemove(file.Id, out _);
            return Task.CompletedTask;
        }

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;

        private static BackupDestinationException Refused() => new("The destination cannot be reached (the DevHost pretends it is offline).");
    }
}

internal sealed class PretendTelegram : ITelegramConnector
{
    public ITelegramLoginClient StartLogin(int apiId, string apiHash) => new Login();

    public Task<ITelegramAccount> OpenAsync(int apiId, string apiHash, byte[] session, string chat, Func<byte[], Task> sessionChanged, CancellationToken cancellationToken) =>
        throw new BackupDestinationException("The DevHost keeps Telegram destinations in memory; this one is opened through them.");

    private sealed class Login : ITelegramLoginClient
    {
        private string? _phone;

        public (string Name, bool Premium) Account => (_phone == "+10000000002" ? "Grace Hopper" : "Ada Lovelace", _phone == "+10000000002");

        public byte[] Session => "devhost-telegram-session"u8.ToArray();

        public Task<string?> LoginAsync(string value)
        {
            if (_phone is null)
            {
                _phone = value;
                return Task.FromResult<string?>("verification_code");
            }

            return value switch
            {
                "12345" => Task.FromResult(_phone == "+10000000002" ? "password" : null),
                "devhost" => Task.FromResult<string?>(null),
                _ when value.Length == 5 => throw new TelegramRefusedException("PHONE_CODE_INVALID"),
                _ => throw new TelegramRefusedException("PASSWORD_HASH_INVALID"),
            };
        }

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}
