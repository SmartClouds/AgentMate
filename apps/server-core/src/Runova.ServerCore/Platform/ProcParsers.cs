using System.Buffers;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.Platform;

/// <summary>The aggregate "cpu" line of /proc/stat, in clock ticks since boot.</summary>
internal sealed record CpuTimes(long User, long Nice, long System, long Idle, long Iowait, long Irq, long SoftIrq, long Steal)
{
    /// <summary>Guest time is already part of user time, so it is not added again.</summary>
    public long Total => User + Nice + System + Idle + Iowait + Irq + SoftIrq + Steal;

    /// <summary>
    /// How the time between two readings was spent. Busy is everything but idle and I/O wait (a CPU
    /// waiting on a disk could have run something else); steal is time the hypervisor took.
    /// </summary>
    public static (double BusyPercent, double IowaitPercent, double StealPercent) Usage(CpuTimes before, CpuTimes after)
    {
        ArgumentNullException.ThrowIfNull(before);
        ArgumentNullException.ThrowIfNull(after);
        double total = after.Total - before.Total;
        if (total <= 0)
        {
            return (0, 0, 0);
        }

        double idle = after.Idle - before.Idle;
        double iowait = after.Iowait - before.Iowait;
        double steal = after.Steal - before.Steal;
        return (
            Math.Clamp((total - idle - iowait) / total * 100, 0, 100),
            Math.Clamp(iowait / total * 100, 0, 100),
            Math.Clamp(steal / total * 100, 0, 100));
    }
}

internal sealed record MemoryReading(long TotalBytes, long AvailableBytes, long SwapTotalBytes, long SwapFreeBytes)
{
    public long UsedBytes => Math.Max(0, TotalBytes - AvailableBytes);

    public long SwapUsedBytes => Math.Max(0, SwapTotalBytes - SwapFreeBytes);
}

/// <summary>Bytes since boot, summed over the interfaces that carry the server's own traffic.</summary>
internal sealed record NetworkCounters(long ReceivedBytes, long TransmittedBytes);

/// <summary>Bytes since boot, summed over whole disks.</summary>
internal sealed record DiskCounters(long ReadBytes, long WrittenBytes);

internal sealed record LoadAverage(double One, double Five, double Fifteen);

internal sealed record MountEntry(string Device, string MountPoint, string FileSystem);

/// <summary>
/// Readers for the /proc files behind the Overview. Each takes the file's text, so the same code
/// runs on a server and on fixtures from both OS families; the formats are the kernel's and do not
/// change between distributions, only between kernel versions (a field or two at the end).
/// </summary>
internal static partial class ProcParsers
{
    private const long SectorBytes = 512;

    private static readonly SearchValues<char> _octalDigits = SearchValues.Create("01234567");

    /// <summary>Filesystems that hold data. Pseudo filesystems, snaps (squashfs) and container layers are left out.</summary>
    private static readonly HashSet<string> _dataFileSystems = new(StringComparer.Ordinal)
    {
        "ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "vfat", "exfat", "f2fs", "jfs", "reiserfs",
        "nfs", "nfs4", "cifs", "smb3", "ceph", "fuseblk",
    };

    /// <summary>Interfaces whose traffic is already counted on a real one: container and VM plumbing.</summary>
    private static readonly string[] _virtualPrefixes =
    [
        "veth", "docker", "br-", "virbr", "cni", "flannel", "cali", "vxlan", "tunl", "kube-", "lxc", "lxd",
        "podman", "cilium", "weave",
    ];

    /// <summary>ARM CPUs name no model in /proc/cpuinfo; the part number says which core it is.</summary>
    private static readonly Dictionary<(string Implementer, string Part), string> _armParts = new()
    {
        [("0x41", "0xd03")] = "ARM Cortex-A53",
        [("0x41", "0xd05")] = "ARM Cortex-A55",
        [("0x41", "0xd07")] = "ARM Cortex-A57",
        [("0x41", "0xd08")] = "ARM Cortex-A72",
        [("0x41", "0xd0b")] = "ARM Cortex-A76",
        [("0x41", "0xd0c")] = "ARM Neoverse-N1",
        [("0x41", "0xd40")] = "ARM Neoverse-V1",
        [("0x41", "0xd49")] = "ARM Neoverse-N2",
        [("0x41", "0xd4f")] = "ARM Neoverse-V2",
        [("0x41", "0xd84")] = "ARM Neoverse-V3",
        [("0x41", "0xd8e")] = "ARM Neoverse-N3",
        [("0xc0", "0xac3")] = "Ampere AmpereOne",
    };

    public static CpuTimes ParseCpuTimes(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        var line = Lines(text).FirstOrDefault(l => l.StartsWith("cpu ", StringComparison.Ordinal))
            ?? throw new FormatException("/proc/stat has no aggregate cpu line.");
        var values = line.Split(' ', StringSplitOptions.RemoveEmptyEntries).Skip(1).Select(ParseLong).ToArray();
        long At(int index) => index < values.Length ? values[index] : 0;
        return new CpuTimes(At(0), At(1), At(2), At(3), At(4), At(5), At(6), At(7));
    }

    /// <summary>When the system booted, in unix seconds (the btime line of /proc/stat).</summary>
    public static long ParseBootTime(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        var line = Lines(text).FirstOrDefault(l => l.StartsWith("btime ", StringComparison.Ordinal))
            ?? throw new FormatException("/proc/stat has no btime line.");
        return ParseLong(line[6..].Trim());
    }

    public static MemoryReading ParseMemory(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        var fields = new Dictionary<string, long>(StringComparer.Ordinal);
        foreach (var line in Lines(text))
        {
            var colon = line.IndexOf(':', StringComparison.Ordinal);
            if (colon <= 0)
            {
                continue;
            }

            var value = line[(colon + 1)..].Trim();
            var kilobytes = value.EndsWith(" kB", StringComparison.Ordinal);
            if (long.TryParse(kilobytes ? value[..^3] : value, NumberStyles.None, CultureInfo.InvariantCulture, out var number))
            {
                fields[line[..colon]] = kilobytes ? number * 1024 : number;
            }
        }

        long Field(string name) => fields.GetValueOrDefault(name);
        // MemAvailable arrived in Linux 3.14; before it, free plus page cache is the usual estimate.
        var available = fields.TryGetValue("MemAvailable", out var reported)
            ? reported
            : Field("MemFree") + Field("Buffers") + Field("Cached");
        return new MemoryReading(Field("MemTotal"), available, Field("SwapTotal"), Field("SwapFree"));
    }

    public static NetworkCounters ParseNetwork(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        long received = 0;
        long transmitted = 0;
        foreach (var line in Lines(text))
        {
            var colon = line.IndexOf(':', StringComparison.Ordinal);
            if (colon <= 0 || line.Contains('|', StringComparison.Ordinal))
            {
                continue;
            }

            var name = line[..colon].Trim();
            if (!CountsTraffic(name))
            {
                continue;
            }

            var values = line[(colon + 1)..].Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (values.Length >= 9)
            {
                received += ParseLong(values[0]);
                transmitted += ParseLong(values[8]);
            }
        }

        return new NetworkCounters(received, transmitted);
    }

    /// <summary>Loopback and container plumbing are left out; their traffic is counted elsewhere or never leaves.</summary>
    public static bool CountsTraffic(string interfaceName)
    {
        ArgumentNullException.ThrowIfNull(interfaceName);
        return interfaceName != "lo"
            && !_virtualPrefixes.Any(prefix => interfaceName.StartsWith(prefix, StringComparison.Ordinal));
    }

    public static DiskCounters ParseDisks(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        long read = 0;
        long written = 0;
        foreach (var line in Lines(text))
        {
            // major minor name reads merged sectors-read ms writes merged sectors-written ...
            var fields = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (fields.Length < 10 || !WholeDisk().IsMatch(fields[2]))
            {
                continue;
            }

            read += ParseLong(fields[5]) * SectorBytes;
            written += ParseLong(fields[9]) * SectorBytes;
        }

        return new DiskCounters(read, written);
    }

    public static LoadAverage ParseLoad(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        var fields = text.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (fields.Length < 3)
        {
            throw new FormatException("/proc/loadavg has fewer than three averages.");
        }

        return new LoadAverage(ParseDouble(fields[0]), ParseDouble(fields[1]), ParseDouble(fields[2]));
    }

    public static double ParseUptimeSeconds(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        var first = text.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).FirstOrDefault()
            ?? throw new FormatException("/proc/uptime is empty.");
        return ParseDouble(first);
    }

    public static CpuInfo ParseCpuInfo(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        var processors = new List<Dictionary<string, string>>();
        Dictionary<string, string>? current = null;
        foreach (var line in text.Split('\n'))
        {
            var colon = line.IndexOf(':', StringComparison.Ordinal);
            if (colon <= 0)
            {
                continue;
            }

            var key = line[..colon].Trim();
            var value = line[(colon + 1)..].Trim();
            if (key == "processor")
            {
                current = new Dictionary<string, string>(StringComparer.Ordinal);
                processors.Add(current);
            }

            if (current is not null)
            {
                current[key] = value;
            }
        }

        var first = processors.FirstOrDefault() ?? [];
        var model = first.GetValueOrDefault("model name") is { Length: > 0 } named
            ? named
            : ArmModel(first) ?? first.GetValueOrDefault("Hardware") ?? "Unknown CPU";
        var logical = Math.Max(1, processors.Count);
        var sockets = processors
            .Select(p => p.GetValueOrDefault("physical id"))
            .Where(id => id is not null)
            .Distinct(StringComparer.Ordinal)
            .Count();
        var cores = processors
            .Where(p => p.ContainsKey("physical id") && p.ContainsKey("core id"))
            .Select(p => (p["physical id"], p["core id"]))
            .Distinct()
            .Count();
        return new CpuInfo(model, logical, cores > 0 ? cores : logical, Math.Max(1, sockets));
    }

    /// <summary>Filesystems that hold data, once per device, in mount order.</summary>
    public static IReadOnlyList<MountEntry> ParseMounts(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        var mounts = new List<MountEntry>();
        var devices = new HashSet<string>(StringComparer.Ordinal);
        foreach (var line in Lines(text))
        {
            var fields = line.Split(' ');
            if (fields.Length < 3 || !_dataFileSystems.Contains(fields[2]))
            {
                continue;
            }

            var device = Unescape(fields[0]);
            // A device mounted twice (a bind mount, a btrfs subvolume) is still one set of blocks.
            if (devices.Add(device))
            {
                mounts.Add(new MountEntry(device, Unescape(fields[1]), fields[2]));
            }
        }

        return mounts;
    }

    private static string? ArmModel(Dictionary<string, string> processor)
    {
        if (!processor.TryGetValue("CPU implementer", out var implementer) || !processor.TryGetValue("CPU part", out var part))
        {
            return null;
        }

        return _armParts.TryGetValue((implementer, part), out var name) ? name : $"ARM CPU (implementer {implementer}, part {part})";
    }

    /// <summary>The kernel writes a space in a path as \040 (and a tab, newline or backslash the same way).</summary>
    private static string Unescape(string field)
    {
        if (!field.Contains('\\', StringComparison.Ordinal))
        {
            return field;
        }

        var text = new StringBuilder(field.Length);
        for (var i = 0; i < field.Length; i++)
        {
            if (field[i] == '\\' && IsOctal(field, i + 1))
            {
                text.Append((char)Convert.ToInt32(field.Substring(i + 1, 3), 8));
                i += 3;
            }
            else
            {
                text.Append(field[i]);
            }
        }

        return text.ToString();
    }

    private static bool IsOctal(string text, int start) =>
        start + 3 <= text.Length && text.AsSpan(start, 3).IndexOfAnyExcept(_octalDigits) < 0;

    private static IEnumerable<string> Lines(string text) =>
        text.Split('\n').Select(line => line.TrimEnd('\r')).Where(line => line.Length > 0);

    private static long ParseLong(string value) =>
        long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var number) ? number : 0;

    private static double ParseDouble(string value) =>
        double.Parse(value, NumberStyles.Float, CultureInfo.InvariantCulture);

    /// <summary>Whole disks only: their partitions, device-mapper volumes and md arrays would count the same bytes again.</summary>
    [GeneratedRegex(@"^(?:sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|nvme\d+n\d+|mmcblk\d+)$", RegexOptions.CultureInvariant)]
    private static partial Regex WholeDisk();
}
