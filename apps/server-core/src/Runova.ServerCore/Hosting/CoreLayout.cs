using Runova.ServerCore.Compatibility;

namespace Runova.ServerCore.Hosting;

/// <summary>Which of the two installed layouts a core runs in.</summary>
internal enum CoreLayoutKind
{
    /// <summary>The layout from before the rename (release 1.63 and older), until `migrate-layout` moves it.</summary>
    Legacy,

    Runova,
}

/// <summary>
/// Where an installed core lives: its program, releases, state, configuration, socket, unit and
/// group. One binary runs in either layout and picks one when it starts, from the folder it was
/// started from, so a server that never migrates keeps working as it is.
/// </summary>
internal sealed record CoreLayout
{
    /// <summary>The new prefix every transient unit gets; <see cref="TransientUnitPrefixes"/> lists what is still recognised.</summary>
    public const string TransientUnitPrefix = "runova-";

    public static readonly IReadOnlyList<string> TransientUnitPrefixes = [TransientUnitPrefix, LegacyNames.TransientUnitPrefix];

    /// <summary>The Host headers that mean the core: the new name and the one old desktops send.</summary>
    public static readonly IReadOnlyList<string> HostNames = ["runova-core", LegacyNames.Host];

    public static CoreLayout Runova { get; } = new()
    {
        Kind = CoreLayoutKind.Runova,
        Root = "/opt/runova-core",
        DataDirectory = "/var/lib/runova-core",
        ConfigDirectory = "/etc/runova-core",
        RuntimeDirectory = "/run/runova-core",
        Unit = "runova-core",
        Binary = "runova-core",
        Group = "runova",
        TarballPrefix = "runova-core-",
        NeedrestartOverridePath = "/etc/needrestart/conf.d/runova-core.conf",
    };

    public static CoreLayout Legacy { get; } = new()
    {
        Kind = CoreLayoutKind.Legacy,
        Root = LegacyNames.Root,
        DataDirectory = LegacyNames.DataDirectory,
        ConfigDirectory = LegacyNames.ConfigDirectory,
        RuntimeDirectory = LegacyNames.RuntimeDirectory,
        Unit = LegacyNames.Unit,
        Binary = LegacyNames.Binary,
        Group = LegacyNames.Group,
        TarballPrefix = LegacyNames.TarballPrefix,
        NeedrestartOverridePath = LegacyNames.NeedrestartOverridePath,
    };

    private static readonly Lazy<CoreLayout> _current = new(
        () => OperatingSystem.IsLinux() ? Detect(Environment.ProcessPath, Directory.Exists) : Runova);

    /// <summary>The layout this process runs in, decided once.</summary>
    public static CoreLayout Current => _current.Value;

    public required CoreLayoutKind Kind { get; init; }

    /// <summary>The program's folder: releases/, the current link and the update staging folder.</summary>
    public required string Root { get; init; }

    /// <summary>systemd's StateDirectory: created for root only (0700) before the core starts.</summary>
    public required string DataDirectory { get; init; }

    public required string ConfigDirectory { get; init; }

    /// <summary>systemd's RuntimeDirectory, which holds the socket.</summary>
    public required string RuntimeDirectory { get; init; }

    public required string Unit { get; init; }

    /// <summary>The program's file name inside a release.</summary>
    public required string Binary { get; init; }

    /// <summary>The group whose members may open the socket.</summary>
    public required string Group { get; init; }

    /// <summary>Release tarballs are named &lt;prefix&gt;&lt;version&gt;-&lt;rid&gt;.tar.gz.</summary>
    public required string TarballPrefix { get; init; }

    public required string NeedrestartOverridePath { get; init; }

    /// <summary>How the health endpoint names the layout: "legacy" or "runova".</summary>
    public string Name => Kind == CoreLayoutKind.Legacy ? "legacy" : "runova";

    public string Releases => Root + "/releases";

    public string CurrentLink => Root + "/current";

    public string Staging => Root + "/update";

    /// <summary>The program as the unit starts it, through the current link.</summary>
    public string BinaryPath => CurrentLink + "/" + Binary;

    public string ConfigFile => ConfigDirectory + "/core.json";

    public string SocketPath => RuntimeDirectory + "/core.sock";

    public string UnitFile => Unit + ".service";

    public string UnitPath => "/etc/systemd/system/" + UnitFile;

    public string TarballName(string version, string rid) => $"{TarballPrefix}{version}-{rid}.tar.gz";

    /// <summary>
    /// The layout of the core at <paramref name="processPath"/> (as Linux reports it, with every
    /// link resolved). A core started from anywhere else (a build folder, the system tests) takes
    /// the layout whose state folder is on the machine, the new one when neither or both are.
    /// </summary>
    public static CoreLayout Detect(string? processPath, Func<string, bool> directoryExists)
    {
        ArgumentNullException.ThrowIfNull(directoryExists);
        if (processPath is not null)
        {
            if (processPath.StartsWith(Runova.Root + "/", StringComparison.Ordinal))
            {
                return Runova;
            }

            if (processPath.StartsWith(Legacy.Root + "/", StringComparison.Ordinal))
            {
                return Legacy;
            }
        }

        return directoryExists(Legacy.DataDirectory) && !directoryExists(Runova.DataDirectory) ? Legacy : Runova;
    }

    /// <summary>The other layout: where a migration goes from this one, or came from.</summary>
    public CoreLayout Other => Kind == CoreLayoutKind.Legacy ? Runova : Legacy;
}
