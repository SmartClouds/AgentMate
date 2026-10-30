using System.Net.Sockets;
using System.Text.Json;
using System.Threading.Channels;
using Docker.DotNet;
using Docker.DotNet.Models;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Registries;
using VolumeInfo = Runova.ServerCore.Contracts.VolumeInfo;

namespace Runova.ServerCore.Docker;

/// <summary>Images, volumes, networks, disk usage, prunes and events.</summary>
internal sealed partial class DockerEngine
{
    public Task<IReadOnlyList<ImageInfo>> ListImagesAsync(CancellationToken cancellationToken) =>
        CallAsync<IReadOnlyList<ImageInfo>>(
            async client =>
            {
                var images = await client.Images.ListImagesAsync(new ImagesListParameters { All = false }, cancellationToken);
                var containers = await AllContainersAsync(client, cancellationToken);
                var users = containers.GroupBy(c => c.ImageID, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.Count(), StringComparer.Ordinal);
                return [.. images
                    .OrderByDescending(image => image.Created)
                    .Select(image => new ImageInfo(
                        image.ID,
                        [.. (image.RepoTags ?? []).Where(tag => tag != "<none>:<none>")],
                        [.. (image.RepoDigests ?? []).Where(digest => digest != "<none>@<none>")],
                        DockerMapping.UnixMs(image.Created),
                        image.Size,
                        users.GetValueOrDefault(image.ID)))];
            },
            cancellationToken);

    public Task PullImageAsync(ImageReference image, Action<PullProgress> progress, CancellationToken cancellationToken, RegistryLogin? login = null)
    {
        ArgumentNullException.ThrowIfNull(image);
        ArgumentNullException.ThrowIfNull(progress);
        var parameters = image.Digest is null
            ? new ImagesCreateParameters { FromImage = image.Repository, Tag = image.Tag ?? "latest" }
            : new ImagesCreateParameters { FromImage = $"{image.Repository}@{image.Digest}" };
        return CallAsync(
            async client =>
            {
                string? failure = null;
                await client.Images.CreateImageAsync(
                    parameters,
                    login is null
                        ? null
                        : new AuthConfig { Username = login.Username, Password = login.Secret, ServerAddress = RegistryNames.ConfigKey(login.Registry) },
                    new Reporter<JSONMessage>(message =>
                    {
                        failure ??= message.Error?.Message;
                        progress(new PullProgress(message.ID, message.Status, message.Progress?.Current, message.Progress?.Total, message.Error?.Message));
                    }),
                    cancellationToken);
                if (failure is not null)
                {
                    throw new DockerRequestException(failure);
                }
            },
            cancellationToken);
    }

    public Task RemoveImageAsync(string image, bool force, CancellationToken cancellationToken) =>
        CallAsync(client => client.Images.DeleteImageAsync(image, new ImageDeleteParameters { Force = force }, cancellationToken), cancellationToken);

    public Task<IReadOnlyList<VolumeInfo>> ListVolumesAsync(CancellationToken cancellationToken) =>
        CallAsync<IReadOnlyList<VolumeInfo>>(
            async client =>
            {
                var volumes = await client.Volumes.ListAsync(cancellationToken);
                var containers = await AllContainersAsync(client, cancellationToken);
                return [.. (volumes.Volumes ?? [])
                    .OrderBy(volume => volume.Name, StringComparer.Ordinal)
                    .Select(volume => new VolumeInfo(
                        volume.Name,
                        volume.Driver ?? "local",
                        volume.Mountpoint ?? string.Empty,
                        containers.Count(c => c.Mounts?.Any(m => m.Name == volume.Name) == true),
                        DockerTime.ToUnixMs(volume.CreatedAt),
                        volume.UsageData is { Size: >= 0 } usage ? usage.Size : null,
                        DockerMapping.Label(volume.Labels, DockerMapping.ProjectLabel)))];
            },
            cancellationToken);

    public Task RemoveVolumeAsync(string volume, bool force, CancellationToken cancellationToken) =>
        CallAsync(client => client.Volumes.RemoveAsync(volume, force, cancellationToken), cancellationToken);

    public Task<IReadOnlyList<NetworkInfo>> ListNetworksAsync(CancellationToken cancellationToken) =>
        CallAsync<IReadOnlyList<NetworkInfo>>(
            async client =>
            {
                var networks = await client.Networks.ListNetworksAsync(new NetworksListParameters(), cancellationToken);
                var containers = await AllContainersAsync(client, cancellationToken);
                return [.. networks
                    .OrderBy(network => network.Name, StringComparer.Ordinal)
                    .Select(network => new NetworkInfo(
                        network.ID,
                        network.Name,
                        network.Driver ?? string.Empty,
                        network.Scope ?? "local",
                        network.Internal,
                        network.Name is "bridge" or "host" or "none",
                        [.. (network.IPAM?.Config ?? []).Select(config => config.Subnet).Where(subnet => !string.IsNullOrEmpty(subnet))],
                        containers.Count(c => c.NetworkSettings?.Networks?.ContainsKey(network.Name) == true),
                        DockerMapping.Label(network.Labels, DockerMapping.ProjectLabel)))];
            },
            cancellationToken);

    public Task RemoveNetworkAsync(string network, CancellationToken cancellationToken) =>
        CallAsync(client => client.Networks.DeleteNetworkAsync(network, cancellationToken), cancellationToken);

    /// <summary>The engine's own summary (API 1.52 and later); older engines get one counted from the lists.</summary>
    public Task<DockerDiskUsage> GetDiskUsageAsync(CancellationToken cancellationToken) =>
        CallAsync(
            async client =>
            {
                var usage = await client.System.GetDataUsageInfoAsync(cancellationToken: cancellationToken);
                if (usage.ImageUsage is { } images && usage.ContainerUsage is { } containers && usage.VolumeUsage is { } volumes)
                {
                    var cache = usage.BuildCacheUsage;
                    return new DockerDiskUsage(
                        Entry(images.TotalCount, images.ActiveCount, images.TotalSize, images.Reclaimable),
                        Entry(containers.TotalCount, containers.ActiveCount, containers.TotalSize, containers.Reclaimable),
                        Entry(volumes.TotalCount, volumes.ActiveCount, volumes.TotalSize, volumes.Reclaimable),
                        Entry(cache?.TotalCount, cache?.ActiveCount, cache?.TotalSize, cache?.Reclaimable));
                }

                return await CountedUsageAsync(client, cancellationToken);
            },
            cancellationToken);

    public Task<DockerPruneResult> PruneAsync(DockerPruneTarget target, bool allImages, CancellationToken cancellationToken) =>
        CallAsync(
            async client =>
            {
                switch (target)
                {
                    case DockerPruneTarget.Containers:
                        var containers = await client.Containers.PruneContainersAsync(new ContainersPruneParameters(), cancellationToken);
                        return new DockerPruneResult(containers.ContainersDeleted?.Count ?? 0, (long)containers.SpaceReclaimed);
                    case DockerPruneTarget.Images:
                        var images = await client.Images.PruneImagesAsync(
                            new ImagesPruneParameters
                            {
                                Filters = new Dictionary<string, IDictionary<string, bool>>
                                {
                                    ["dangling"] = new Dictionary<string, bool> { [allImages ? "false" : "true"] = true },
                                },
                            },
                            cancellationToken);
                        return new DockerPruneResult(images.ImagesDeleted?.Count ?? 0, (long)images.SpaceReclaimed);
                    case DockerPruneTarget.Volumes:
                        var volumes = await client.Volumes.PruneAsync(new VolumesPruneParameters(), cancellationToken);
                        return new DockerPruneResult(volumes.VolumesDeleted?.Count ?? 0, (long)volumes.SpaceReclaimed);
                    case DockerPruneTarget.Networks:
                        var networks = await client.Networks.PruneNetworksAsync(new NetworksDeleteUnusedParameters(), cancellationToken);
                        return new DockerPruneResult(networks.NetworksDeleted?.Count ?? 0, 0);
                    case DockerPruneTarget.BuildCache:
                        return await PruneBuildCacheAsync(cancellationToken);
                    default:
                        throw new ArgumentOutOfRangeException(nameof(target), "Prune one kind at a time.");
                }
            },
            cancellationToken);

    /// <summary>
    /// `docker builder prune --all`. Docker.DotNet has no call for it, so this one goes over the
    /// same socket by hand, in the API version the engine was negotiated at.
    /// </summary>
    private async Task<DockerPruneResult> PruneBuildCacheAsync(CancellationToken cancellationToken)
    {
        var version = _version?.NegotiatedApiVersion ?? MaxApiVersion.ToString();
        using var http = new HttpClient(new SocketsHttpHandler { ConnectCallback = ConnectSocketAsync })
        {
            BaseAddress = new Uri("http://docker/"),
            Timeout = _requestTimeout,
        };
        using var response = await http.PostAsync($"v{version}/build/prune?all=true", content: null, cancellationToken);
        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            throw new DockerApiException(response.StatusCode, body);
        }

        using var json = JsonDocument.Parse(body);
        var root = json.RootElement;
        var removed = root.TryGetProperty("CachesDeleted", out var deleted) && deleted.ValueKind == JsonValueKind.Array ? deleted.GetArrayLength() : 0;
        var reclaimed = root.TryGetProperty("SpaceReclaimed", out var space) && space.TryGetInt64(out var bytes) ? bytes : 0;
        return new DockerPruneResult(removed, reclaimed);
    }

    private async ValueTask<Stream> ConnectSocketAsync(SocketsHttpConnectionContext context, CancellationToken cancellationToken)
    {
        var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
        try
        {
            await socket.ConnectAsync(new UnixDomainSocketEndPoint(endpoint.LocalPath), cancellationToken);
            return new NetworkStream(socket, ownsSocket: true);
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    }

    /// <summary>A reader that falls this far behind ends the stream rather than missing events silently.</summary>
    public IAsyncEnumerable<EngineEvent> StreamEventsAsync(EventCursor? since, CancellationToken cancellationToken) =>
        StreamAsync<Message, EngineEvent>(
            (client, progress, token) => client.System.MonitorEventsAsync(
                new ContainerEventsParameters { Since = since?.ToEngineTime() },
                progress,
                token),
            DockerMapping.Event,
            new BoundedChannelOptions(1024) { FullMode = BoundedChannelFullMode.Wait, SingleReader = true },
            cancellationToken);

    private static async Task<IList<ContainerListResponse>> AllContainersAsync(DockerClient client, CancellationToken cancellationToken) =>
        await client.Containers.ListContainersAsync(new ContainersListParameters { All = true }, cancellationToken);

    private static async Task<DockerDiskUsage> CountedUsageAsync(DockerClient client, CancellationToken cancellationToken)
    {
        var images = await client.Images.ListImagesAsync(new ImagesListParameters { All = false }, cancellationToken);
        var containers = await client.Containers.ListContainersAsync(new ContainersListParameters { All = true, Size = true }, cancellationToken);
        var volumes = (await client.Volumes.ListAsync(cancellationToken)).Volumes ?? [];
        var used = containers.Select(c => c.ImageID).ToHashSet(StringComparer.Ordinal);
        var running = containers.Where(c => c.State == "running").ToList();
        var mounted = containers.SelectMany(c => c.Mounts ?? []).Select(m => m.Name).Where(n => n is not null).ToHashSet(StringComparer.Ordinal);
        return new DockerDiskUsage(
            new DockerDiskUsageEntry(images.Count, images.Count(i => used.Contains(i.ID)), images.Sum(i => i.Size), images.Where(i => !used.Contains(i.ID)).Sum(i => i.Size)),
            new DockerDiskUsageEntry(containers.Count, running.Count, containers.Sum(c => c.SizeRw ?? 0), containers.Except(running).Sum(c => c.SizeRw ?? 0)),
            new DockerDiskUsageEntry(
                volumes.Count,
                volumes.Count(v => mounted.Contains(v.Name)),
                volumes.Sum(v => Math.Max(v.UsageData?.Size ?? 0, 0)),
                volumes.Where(v => !mounted.Contains(v.Name)).Sum(v => Math.Max(v.UsageData?.Size ?? 0, 0))),
            new DockerDiskUsageEntry(0, 0, 0, 0));
    }

    private static DockerDiskUsageEntry Entry(long? count, long? active, long? size, long? reclaimable) =>
        new((int)(count ?? 0), (int)(active ?? 0), size ?? 0, reclaimable ?? 0);
}
