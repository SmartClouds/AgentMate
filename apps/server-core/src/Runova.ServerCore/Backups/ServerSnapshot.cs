using System.Text.Json.Serialization;
using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.Backups;

/// <summary>A Docker volume as a backup lists it.</summary>
internal sealed record BackupVolume(string Name, string Driver, IReadOnlyDictionary<string, string> Labels)
{
    public string? ComposeProject => Labels.TryGetValue("com.docker.compose.project", out var project) ? project : null;
}

/// <summary>An image: its tags and the digests a registry knows it by. None means it was built here.</summary>
internal sealed record BackupImage(string Id, string[] Tags, string[] RepoDigests);

internal sealed record PortSpec(string ContainerPort, string? HostIp, string? HostPort);

/// <summary>What it takes to create a standalone container again.</summary>
internal sealed record ContainerSpec(
    string[] Env,
    string[]? Cmd,
    string[]? Entrypoint,
    string? WorkingDir,
    string? User,
    Dictionary<string, string> Labels,
    string[] Binds,
    PortSpec[] Ports,
    string? RestartPolicy,
    string? NetworkMode);

/// <summary>A container, with the compose project it belongs to (none for one started by hand).</summary>
internal sealed record BackupContainer(string Name, string Image, string? ComposeProject, bool Running, ContainerSpec Spec);

/// <summary>A volume in the archive, at server/volumes/File.</summary>
internal sealed record VolumeEntry(string Name, string Driver, IReadOnlyDictionary<string, string> Labels, string File, long SizeBytes);

/// <summary>An image; File is set when it was saved into the archive because no registry has it.</summary>
internal sealed record ImageEntry(string Id, string[] Tags, string[] RepoDigests, string? File);

/// <summary>The rules Runova can put back, and the policy around them.</summary>
internal sealed record FirewallRulesSnapshot(FirewallBackendKind Backend, bool Active, FirewallPolicy DefaultIncoming, FirewallRuleSpec[] Rules);

/// <summary>
/// What a full backup knows about the server beyond the core's state (server/server.json): its
/// addresses (to move settings to a new one), its volumes and images, the compose projects that
/// were running, the containers started by hand, and the firewall.
/// </summary>
internal sealed record ServerSnapshot(
    int Format,
    string HostName,
    long CreatedAtUnixMs,
    string[] Addresses,
    bool Docker,
    VolumeEntry[] Volumes,
    ImageEntry[] Images,
    BackupContainer[] Containers,
    string[] RunningProjects,
    FirewallRulesSnapshot? Firewall,
    bool HasCoreConfig,
    bool LiveCopy)
{
    public const int CurrentFormat = 1;
    public const string Folder = "server";
    public const string FileName = "server/server.json";
    public const string ConfigFile = "server/config/core.json";
    public const string VolumesFolder = "server/volumes";
    public const string ImagesFolder = "server/images";
}

[JsonSerializable(typeof(ServerSnapshot))]
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, WriteIndented = true, UseStringEnumConverter = true)]
internal sealed partial class ServerSnapshotJson : JsonSerializerContext;

/// <summary>What a backup needs from Docker. Volumes are read through a helper container, never host paths.</summary>
internal interface IBackupDocker
{
    Task<bool> IsAvailableAsync(CancellationToken cancellationToken);

    Task<IReadOnlyList<BackupVolume>> ListVolumesAsync(CancellationToken cancellationToken);

    /// <summary>Writes a tar of everything in the volume, read live, to <paramref name="output"/>.</summary>
    Task ExportVolumeAsync(string volume, Stream output, CancellationToken cancellationToken);

    /// <summary>Makes the volume if it is missing, empties it, and unpacks the tar into it.</summary>
    Task ImportVolumeAsync(BackupVolume volume, Stream tar, CancellationToken cancellationToken);

    Task<IReadOnlyList<BackupImage>> ListImagesAsync(CancellationToken cancellationToken);

    Task SaveImagesAsync(IReadOnlyList<string> images, Stream output, CancellationToken cancellationToken);

    Task LoadImagesAsync(Stream tar, CancellationToken cancellationToken);

    Task PullImageAsync(string reference, CancellationToken cancellationToken);

    Task<IReadOnlyList<BackupContainer>> ListContainersAsync(CancellationToken cancellationToken);

    Task RecreateContainerAsync(BackupContainer container, CancellationToken cancellationToken);
}

/// <summary>The server's own facts a backup records: its public addresses and its firewall.</summary>
internal interface IServerStateReader
{
    Task<string[]> AddressesAsync(CancellationToken cancellationToken);

    Task<FirewallRulesSnapshot?> FirewallAsync(CancellationToken cancellationToken);
}
