using System.Runtime.CompilerServices;
using System.Threading.Channels;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Registries;

namespace Runova.ServerCore.Docker;

/// <summary>The pretend engine's images, volumes, networks, pulls, prunes and events.</summary>
internal sealed partial class InMemoryDockerEngine
{
    private static readonly string[] _builtInNetworks = ["bridge", "host", "none"];

    public Task<IReadOnlyList<ImageInfo>> ListImagesAsync(CancellationToken cancellationToken)
    {
        EnsureRunning();
        lock (_gate)
        {
            return Task.FromResult<IReadOnlyList<ImageInfo>>([.. _images.Select(image => image with { Containers = _containers.Count(c => c.ImageId == image.Id) })]);
        }
    }

    public async Task PullImageAsync(ImageReference image, Action<PullProgress> progress, CancellationToken cancellationToken, RegistryLogin? login = null)
    {
        ArgumentNullException.ThrowIfNull(image);
        ArgumentNullException.ThrowIfNull(progress);
        EnsureRunning();
        var name = image.ToString();
        Changes.Enqueue($"pull {name}");
        var registry = RegistryNames.HostOfRepository(image.Repository);
        if (!SignedIn(registry, login?.Username, login?.Secret))
        {
            throw new DockerRequestException($"Head \"https://{registry}/v2/{image.Repository}/manifests/{image.Tag ?? "latest"}\": unauthorized: authentication required");
        }
        if (image.Repository.Contains("no-such", StringComparison.Ordinal) || image.Tag?.Contains("no-such", StringComparison.Ordinal) == true)
        {
            throw new DockerNotFoundException($"failed to resolve reference \"docker.io/library/{name}\": not found");
        }

        var step = Tick / 5;
        progress(new PullProgress(image.Tag ?? "latest", $"Pulling from {image.Repository}", null, null, null));
        string[] layers = [IdOf(name + "1")[..12], IdOf(name + "2")[..12], IdOf(name + "3")[..12]];
        foreach (var layer in layers)
        {
            progress(new PullProgress(layer, "Pulling fs layer", null, null, null));
        }

        foreach (var layer in layers)
        {
            const long total = 24_117_248;
            for (var part = 1; part <= 4; part++)
            {
                await Task.Delay(step, _time, cancellationToken);
                progress(new PullProgress(layer, "Downloading", total * part / 4, total, null));
            }

            progress(new PullProgress(layer, "Download complete", null, null, null));
            progress(new PullProgress(layer, "Pull complete", null, null, null));
        }

        var digest = "sha256:" + IdOf(name + "digest");
        progress(new PullProgress(null, $"Digest: {digest}", null, null, null));
        progress(new PullProgress(null, $"Status: Downloaded newer image for {name}", null, null, null));
        lock (_gate)
        {
            var id = "sha256:" + IdOf(name);
            _images.RemoveAll(existing => existing.Id == id);
            _images.Insert(0, new ImageInfo(id, [name], [$"{image.Repository}@{digest}"], NowMs, 3 * 24_117_248, 0));
            Raise(new EngineEvent("image", "pull", name, NextEventNano(), new Dictionary<string, string>(StringComparer.Ordinal) { ["name"] = name }));
        }
    }

    public Task RemoveImageAsync(string image, bool force, CancellationToken cancellationToken)
    {
        EnsureRunning();
        lock (_gate)
        {
            var found = _images.FirstOrDefault(i => i.Id == image || i.Id == "sha256:" + image || i.Tags.Contains(image) || (image.Length >= 12 && i.Id.Replace("sha256:", string.Empty, StringComparison.Ordinal).StartsWith(image, StringComparison.Ordinal)))
                ?? throw new DockerNotFoundException($"No such image: {image}");
            var user = _containers.FirstOrDefault(c => c.ImageId == found.Id);
            if (user is not null && !force)
            {
                throw new DockerRequestException(
                    $"conflict: unable to remove repository reference \"{image}\" (must force) - container {user.Id[..12]} is using its referenced image {found.Id[7..19]}");
            }

            _images.Remove(found);
            Changes.Enqueue($"remove-image {image}");
            Raise(new EngineEvent("image", "delete", found.Id, NextEventNano(), new Dictionary<string, string>(StringComparer.Ordinal) { ["name"] = image }));
        }

        return Task.CompletedTask;
    }

    public Task<IReadOnlyList<VolumeInfo>> ListVolumesAsync(CancellationToken cancellationToken)
    {
        EnsureRunning();
        lock (_gate)
        {
            return Task.FromResult<IReadOnlyList<VolumeInfo>>([.. _volumes.Select(volume => new VolumeInfo(
                volume.Name,
                "local",
                $"/var/lib/docker/volumes/{volume.Name}/_data",
                UsersOf(volume),
                volume.CreatedMs,
                volume.SizeBytes,
                volume.Project))]);
        }
    }

    public Task RemoveVolumeAsync(string volume, bool force, CancellationToken cancellationToken)
    {
        EnsureRunning();
        lock (_gate)
        {
            var found = _volumes.FirstOrDefault(v => v.Name == volume) ?? throw new DockerNotFoundException($"get {volume}: no such volume");
            if (UsersOf(found) > 0)
            {
                var users = _containers.Where(c => c.Mounts.Any(m => m.Name == volume)).Select(c => c.Id);
                throw new DockerRequestException($"remove {volume}: volume is in use - [{string.Join(", ", users)}]");
            }

            _volumes.Remove(found);
            Changes.Enqueue($"remove-volume {volume}");
            Raise(new EngineEvent("volume", "destroy", volume, NextEventNano(), new Dictionary<string, string>(StringComparer.Ordinal)));
        }

        return Task.CompletedTask;
    }

    public Task<IReadOnlyList<NetworkInfo>> ListNetworksAsync(CancellationToken cancellationToken)
    {
        EnsureRunning();
        lock (_gate)
        {
            return Task.FromResult<IReadOnlyList<NetworkInfo>>([.. _networks.Select(network => new NetworkInfo(
                IdOf("network:" + network.Name),
                network.Name,
                network.Name is "host" or "none" ? network.Name == "host" ? "host" : "null" : "bridge",
                "local",
                false,
                _builtInNetworks.Contains(network.Name),
                network.Subnet is null ? [] : [network.Subnet],
                _containers.Count(c => c.Networks.Contains(network.Name)),
                network.Project))]);
        }
    }

    public Task RemoveNetworkAsync(string network, CancellationToken cancellationToken)
    {
        EnsureRunning();
        lock (_gate)
        {
            var found = _networks.FirstOrDefault(n => n.Name == network || IdOf("network:" + n.Name).StartsWith(network, StringComparison.Ordinal))
                ?? throw new DockerNotFoundException($"network {network} not found");
            if (_builtInNetworks.Contains(found.Name))
            {
                throw new DockerRequestException($"{found.Name} is a pre-defined network and cannot be removed");
            }

            if (_containers.Any(c => c.Networks.Contains(found.Name)))
            {
                throw new DockerRequestException($"error while removing network: network {found.Name} has active endpoints");
            }

            _networks.Remove(found);
            Changes.Enqueue($"remove-network {found.Name}");
            Raise(new EngineEvent("network", "destroy", IdOf("network:" + found.Name), NextEventNano(), new Dictionary<string, string>(StringComparer.Ordinal) { ["name"] = found.Name }));
        }

        return Task.CompletedTask;
    }

    public Task<DockerDiskUsage> GetDiskUsageAsync(CancellationToken cancellationToken)
    {
        EnsureRunning();
        lock (_gate)
        {
            var used = _containers.Select(c => c.ImageId).ToHashSet(StringComparer.Ordinal);
            var running = _containers.Where(c => c.State == ContainerState.Running).ToList();
            const long containerLayer = 2 * 1024 * 1024;
            return Task.FromResult(new DockerDiskUsage(
                new DockerDiskUsageEntry(_images.Count, _images.Count(i => used.Contains(i.Id)), _images.Sum(i => i.SizeBytes), _images.Where(i => !used.Contains(i.Id)).Sum(i => i.SizeBytes)),
                new DockerDiskUsageEntry(_containers.Count, running.Count, _containers.Count * containerLayer, (_containers.Count - running.Count) * containerLayer),
                new DockerDiskUsageEntry(_volumes.Count, _volumes.Count(v => UsersOf(v) > 0), _volumes.Sum(v => v.SizeBytes), _volumes.Where(v => UsersOf(v) == 0).Sum(v => v.SizeBytes)),
                new DockerDiskUsageEntry(3, 0, 412 * 1024 * 1024, 412 * 1024 * 1024)));
        }
    }

    public Task<DockerPruneResult> PruneAsync(DockerPruneTarget target, bool allImages, CancellationToken cancellationToken)
    {
        EnsureRunning();
        lock (_gate)
        {
            Changes.Enqueue($"prune {target}{(allImages ? " all" : string.Empty)}");
            switch (target)
            {
                case DockerPruneTarget.Containers:
                    var stopped = _containers.Where(c => c.State is not (ContainerState.Running or ContainerState.Paused or ContainerState.Restarting)).ToList();
                    stopped.ForEach(c => _containers.Remove(c));
                    return Task.FromResult(new DockerPruneResult(stopped.Count, stopped.Count * 2L * 1024 * 1024));
                case DockerPruneTarget.Images:
                    var used = _containers.Select(c => c.ImageId).ToHashSet(StringComparer.Ordinal);
                    var unused = _images.Where(i => !used.Contains(i.Id) && (allImages || i.Tags.Length == 0)).ToList();
                    unused.ForEach(i => _images.Remove(i));
                    return Task.FromResult(new DockerPruneResult(unused.Count, unused.Sum(i => i.SizeBytes)));
                case DockerPruneTarget.Volumes:
                    var loose = _volumes.Where(v => v.Anonymous && UsersOf(v) == 0).ToList();
                    loose.ForEach(v => _volumes.Remove(v));
                    return Task.FromResult(new DockerPruneResult(loose.Count, loose.Sum(v => v.SizeBytes)));
                case DockerPruneTarget.Networks:
                    var idle = _networks.Where(n => !_builtInNetworks.Contains(n.Name) && !_containers.Any(c => c.Networks.Contains(n.Name))).ToList();
                    idle.ForEach(n => _networks.Remove(n));
                    return Task.FromResult(new DockerPruneResult(idle.Count, 0));
                default:
                    throw new ArgumentOutOfRangeException(nameof(target), "Prune one kind at a time.");
            }
        }
    }

    public async IAsyncEnumerable<EngineEvent> StreamEventsAsync(EventCursor? since, [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        EnsureRunning();
        var listener = Channel.CreateUnbounded<EngineEvent>(new UnboundedChannelOptions { SingleReader = true });
        List<EngineEvent> past;
        lock (_gate)
        {
            past = since is { } from ? [.. _history.Where(e => e.TimeNano >= from.UnixNanoseconds)] : [];
            _listeners.Add(listener);
        }

        try
        {
            foreach (var engineEvent in past)
            {
                yield return engineEvent;
            }

            await foreach (var engineEvent in listener.Reader.ReadAllAsync(cancellationToken))
            {
                yield return engineEvent;
            }
        }
        finally
        {
            lock (_gate)
            {
                _listeners.Remove(listener);
            }
        }
    }

    private int UsersOf(VolumeEntry volume) => _containers.Count(c => c.Mounts.Any(m => m.Name == volume.Name));

    private sealed record VolumeEntry(string Name, long CreatedMs, long SizeBytes, string? Project, bool Anonymous);

    private sealed record NetworkEntry(string Name, string? Subnet, string? Project);
}
