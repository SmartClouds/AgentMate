using Docker.DotNet;
using Docker.DotNet.Models;
using Runova.ServerCore.Compatibility;
using Runova.ServerCore.Docker;

namespace Runova.ServerCore.Backups;

/// <summary>
/// Docker for backups (E28), through Docker.DotNet at the oldest API the core supports (1.44, Docker
/// 25), so no negotiation is needed. A volume is read and written through a helper container
/// (busybox, pinned by digest, no network) with the volume at /data, through the archive API: no
/// host path is ever touched. Reading needs no running container; writing first empties the volume
/// with the helper's own rm, then unpacks into it.
/// </summary>
internal sealed class DockerBackupEngine(Uri endpoint) : IBackupDocker, IDisposable
{
    public const string HelperImage = "busybox@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e";
    public const string HelperLabel = "runova.backup-helper";

    private static readonly System.Version _apiVersion = new(1, 44);
    private static readonly TimeSpan _timeout = TimeSpan.FromHours(6);

    private readonly Lazy<DockerClient> _client = new(() => Build(endpoint));

    private DockerClient Client => _client.Value;

    public void Dispose()
    {
        if (_client.IsValueCreated)
        {
            _client.Value.Dispose();
        }
    }

    public async Task<bool> IsAvailableAsync(CancellationToken cancellationToken)
    {
        try
        {
            await Client.System.PingAsync(cancellationToken);
            return true;
        }
        catch (Exception error) when (error is HttpRequestException or IOException or TimeoutException or DockerApiException or System.Net.Sockets.SocketException)
        {
            return false;
        }
    }

    public async Task<IReadOnlyList<BackupVolume>> ListVolumesAsync(CancellationToken cancellationToken)
    {
        var listed = await Client.Volumes.ListAsync(cancellationToken);
        return [.. (listed.Volumes ?? []).Select(volume => new BackupVolume(
            volume.Name,
            volume.Driver ?? "local",
            (IReadOnlyDictionary<string, string>?)volume.Labels?.ToDictionary(StringComparer.Ordinal) ?? new Dictionary<string, string>()))];
    }

    public async Task ExportVolumeAsync(string volume, Stream output, CancellationToken cancellationToken)
    {
        var helper = await CreateHelperAsync(volume, readOnly: true, command: null, cancellationToken);
        try
        {
            var archive = await Client.Containers.GetArchiveFromContainerAsync(helper, new ContainerPathStatParameters { Path = "/data/." }, false, cancellationToken);
            await using var stream = archive.Stream ?? throw new IOException($"Docker sent nothing for the volume {volume}.");
            await stream.CopyToAsync(output, cancellationToken);
        }
        finally
        {
            await RemoveHelperAsync(helper);
        }
    }

    public async Task ImportVolumeAsync(BackupVolume volume, Stream tar, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(volume);
        try
        {
            await Client.Volumes.InspectAsync(volume.Name, cancellationToken);
        }
        catch (DockerApiException missing) when (missing.StatusCode == System.Net.HttpStatusCode.NotFound)
        {
            await Client.Volumes.CreateAsync(
                new VolumesCreateParameters { Name = volume.Name, Driver = volume.Driver, Labels = volume.Labels.ToDictionary(StringComparer.Ordinal) },
                cancellationToken);
        }

        // Emptied first, hidden files included, so the volume ends up exactly as it was backed up.
        var cleaner = await CreateHelperAsync(volume.Name, readOnly: false, ["sh", "-c", "rm -rf /data/..?* /data/.[!.]* /data/*"], cancellationToken);
        try
        {
            await Client.Containers.StartContainerAsync(cleaner, new ContainerStartParameters(), cancellationToken);
            var exit = await Client.Containers.WaitContainerAsync(cleaner, cancellationToken);
            if (exit.StatusCode != 0)
            {
                throw new IOException($"The volume {volume.Name} could not be emptied before the restore.");
            }

            await Client.Containers.ExtractArchiveToContainerAsync(cleaner, new CopyToContainerParameters { Path = "/data" }, tar, cancellationToken);
        }
        finally
        {
            await RemoveHelperAsync(cleaner);
        }
    }

    public async Task<IReadOnlyList<BackupImage>> ListImagesAsync(CancellationToken cancellationToken)
    {
        var images = await Client.Images.ListImagesAsync(new ImagesListParameters { All = false }, cancellationToken);
        return [.. images
            .Select(image => new BackupImage(
                image.ID,
                [.. (image.RepoTags ?? []).Where(tag => tag != "<none>:<none>")],
                [.. image.RepoDigests ?? []]))];
    }

    public async Task SaveImagesAsync(IReadOnlyList<string> images, Stream output, CancellationToken cancellationToken)
    {
        await using var saved = await Client.Images.SaveImagesAsync([.. images], cancellationToken);
        await saved.CopyToAsync(output, cancellationToken);
    }

    public Task LoadImagesAsync(Stream tar, CancellationToken cancellationToken) =>
        Client.Images.LoadImageAsync(new ImageLoadParameters { Quiet = true }, tar, new Progress<JSONMessage>(), cancellationToken);

    public Task PullImageAsync(string reference, CancellationToken cancellationToken)
    {
        var (repository, tag) = SplitReference(reference);
        return Client.Images.CreateImageAsync(
            new ImagesCreateParameters { FromImage = repository, Tag = tag },
            new AuthConfig(),
            new Progress<JSONMessage>(),
            cancellationToken);
    }

    public async Task<IReadOnlyList<BackupContainer>> ListContainersAsync(CancellationToken cancellationToken)
    {
        var listed = await Client.Containers.ListContainersAsync(new ContainersListParameters { All = true }, cancellationToken);
        var containers = new List<BackupContainer>();
        foreach (var summary in listed.Where(c => c.Labels is null || !(c.Labels.ContainsKey(HelperLabel) || c.Labels.ContainsKey(LegacyNames.BackupHelperLabel))))
        {
            var inspected = await Client.Containers.InspectContainerAsync(summary.ID, cancellationToken);
            var config = inspected.Config;
            var host = inspected.HostConfig;
            var labels = config?.Labels?.ToDictionary(StringComparer.Ordinal) ?? [];
            labels.TryGetValue("com.docker.compose.project", out var project);
            containers.Add(new BackupContainer(
                (inspected.Name ?? summary.ID).TrimStart('/'),
                config?.Image ?? summary.Image,
                project,
                inspected.State?.Running == true,
                new ContainerSpec(
                    [.. config?.Env ?? []],
                    config?.Cmd is { Count: > 0 } cmd ? [.. cmd] : null,
                    config?.Entrypoint is { Count: > 0 } entry ? [.. entry] : null,
                    string.IsNullOrEmpty(config?.WorkingDir) ? null : config.WorkingDir,
                    string.IsNullOrEmpty(config?.User) ? null : config.User,
                    labels,
                    [.. host?.Binds ?? []],
                    [.. (host?.PortBindings ?? new Dictionary<string, IList<PortBinding>>())
                        .SelectMany(binding => (binding.Value ?? []).Select(port => new PortSpec(binding.Key, NullIfEmpty(port.HostIP), NullIfEmpty(port.HostPort))))],
                    host?.RestartPolicy?.Name.ToString().ToLowerInvariant() is { } restart && restart != "no" ? restart : null,
                    NullIfEmpty(host?.NetworkMode))));
        }

        return containers;
    }

    public async Task RecreateContainerAsync(BackupContainer container, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(container);
        var spec = container.Spec;
        var created = await Client.Containers.CreateContainerAsync(
            new CreateContainerParameters
            {
                Name = container.Name,
                Image = container.Image,
                Env = [.. spec.Env],
                Cmd = spec.Cmd is null ? null! : [.. spec.Cmd],
                Entrypoint = spec.Entrypoint is null ? null! : [.. spec.Entrypoint],
                WorkingDir = spec.WorkingDir ?? string.Empty,
                User = spec.User ?? string.Empty,
                Labels = spec.Labels,
                ExposedPorts = spec.Ports.Select(port => port.ContainerPort).Distinct(StringComparer.Ordinal).ToDictionary(port => port, _ => new EmptyStruct()),
                HostConfig = new HostConfig
                {
                    Binds = [.. spec.Binds],
                    NetworkMode = spec.NetworkMode ?? string.Empty,
                    RestartPolicy = spec.RestartPolicy is null ? null! : new RestartPolicy { Name = Enum.Parse<RestartPolicyKind>(spec.RestartPolicy.Replace("-", string.Empty, StringComparison.Ordinal), ignoreCase: true) },
                    PortBindings = spec.Ports.GroupBy(port => port.ContainerPort, StringComparer.Ordinal).ToDictionary(
                        group => group.Key,
                        group => (IList<PortBinding>)[.. group.Select(port => new PortBinding { HostIP = port.HostIp ?? string.Empty, HostPort = port.HostPort ?? string.Empty })]),
                },
            },
            cancellationToken);
        if (container.Running)
        {
            await Client.Containers.StartContainerAsync(created.ID, new ContainerStartParameters(), cancellationToken);
        }
    }

    private async Task<string> CreateHelperAsync(string volume, bool readOnly, IList<string>? command, CancellationToken cancellationToken)
    {
        await EnsureHelperImageAsync(cancellationToken);
        var created = await Client.Containers.CreateContainerAsync(
            new CreateContainerParameters
            {
                Image = HelperImage,
                Cmd = command ?? ["true"],
                Labels = new Dictionary<string, string> { [HelperLabel] = "1" },
                NetworkDisabled = true,
                HostConfig = new HostConfig
                {
                    Binds = [$"{volume}:/data{(readOnly ? ":ro" : string.Empty)}"],
                    NetworkMode = "none",
                },
            },
            cancellationToken);
        return created.ID;
    }

    private async Task EnsureHelperImageAsync(CancellationToken cancellationToken)
    {
        try
        {
            await Client.Images.InspectImageAsync(HelperImage, cancellationToken);
        }
        catch (DockerImageNotFoundException)
        {
            await PullImageAsync(HelperImage, cancellationToken);
        }
        catch (DockerApiException missing) when (missing.StatusCode == System.Net.HttpStatusCode.NotFound)
        {
            await PullImageAsync(HelperImage, cancellationToken);
        }
    }

    private async Task RemoveHelperAsync(string id)
    {
        try
        {
            await Client.Containers.RemoveContainerAsync(id, new ContainerRemoveParameters { Force = true }, CancellationToken.None);
        }
        catch (DockerApiException)
        {
            // Swept with the other helpers by label at the next backup.
        }
    }

    private static string? NullIfEmpty(string? text) => string.IsNullOrEmpty(text) ? null : text;

    /// <summary>"repo[:tag][@digest]" as the pull API takes it: the repository, and the digest or tag.</summary>
    internal static (string Repository, string Tag) SplitReference(string reference)
    {
        var at = reference.IndexOf('@', StringComparison.Ordinal);
        if (at > 0)
        {
            var name = reference[..at];
            var colon = name.LastIndexOf(':');
            return (colon > name.LastIndexOf('/') && colon > 0 ? name[..colon] : name, reference[(at + 1)..]);
        }

        var tagAt = reference.LastIndexOf(':');
        return tagAt > reference.LastIndexOf('/') && tagAt > 0 ? (reference[..tagAt], reference[(tagAt + 1)..]) : (reference, "latest");
    }

    private static DockerClient Build(Uri endpoint)
    {
        var builder = new DockerClientBuilder().WithEndpoint(endpoint).WithApiVersion(_apiVersion).WithTimeout(_timeout);
        return endpoint.Scheme == "unix" ? builder.WithTransportOptions(UnixSocketTransport.Instance, endpoint.LocalPath).Build() : builder.Build();
    }
}
