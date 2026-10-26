using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Execution;

namespace Runova.ServerCore.Platform;

/// <summary>
/// The Overview's facts about the server. Gathering them starts two small programs (timedatectl
/// and systemctl), so the answer is kept for <see cref="CacheFor"/> and shared by every caller
/// in that time.
/// </summary>
internal sealed class LinuxSystemInfo(
    ISystemFiles files,
    ISystemProbe probe,
    IPackageManager packages,
    IProcessRunner runner,
    OsInfo os,
    TimeProvider time,
    Func<IReadOnlyList<NetworkInterfaceInfo>> networks) : ISystemInfoSource, IDisposable
{
    public static readonly TimeSpan CacheFor = TimeSpan.FromSeconds(30);

    private static readonly string[] _timeServices = ["chrony.service", "chronyd.service", "systemd-timesyncd.service"];

    private readonly SemaphoreSlim _gate = new(1, 1);
    private (SystemInfo Info, long At)? _cached;

    public async Task<SystemInfo> GetAsync(CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var now = time.GetUtcNow().ToUnixTimeMilliseconds();
            if (_cached is { } cached && now - cached.At < (long)CacheFor.TotalMilliseconds)
            {
                return cached.Info;
            }

            var info = await CollectAsync(now, cancellationToken);
            _cached = (info, now);
            return info;
        }
        finally
        {
            _gate.Release();
        }
    }

    public void Dispose() => _gate.Dispose();

    private async Task<SystemInfo> CollectAsync(long now, CancellationToken cancellationToken)
    {
        var memory = ProcParsers.ParseMemory(files.ReadText("/proc/meminfo") ?? string.Empty);
        var bootedAt = files.ReadText("/proc/stat") is { } stat ? ProcParsers.ParseBootTime(stat) * 1000 : 0;
        var shown = networks().Where(nic => ProcParsers.CountsTraffic(nic.Name)).ToArray();
        var publicAddresses = shown
            .SelectMany(nic => nic.Addresses)
            .Where(address => IPAddress.TryParse(address, out var parsed) && NetworkAddresses.IsPublic(parsed))
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        var reboot = await packages.GetRebootStatusAsync(cancellationToken);

        return new SystemInfo(
            FirstLine(files.ReadText("/proc/sys/kernel/hostname")) ?? Environment.MachineName,
            os,
            FirstLine(files.ReadText("/proc/sys/kernel/osrelease")) ?? RuntimeInformation.OSDescription,
            MachineName(RuntimeInformation.OSArchitecture),
            ProcParsers.ParseCpuInfo(files.ReadText("/proc/cpuinfo") ?? string.Empty),
            memory.TotalBytes,
            memory.SwapTotalBytes,
            [.. probe.ReadFilesystems()],
            shown,
            publicAddresses,
            bootedAt,
            await TimeSyncAsync(cancellationToken),
            [.. reboot.Packages],
            now,
            reboot.Required);
    }

    private async Task<TimeSyncInfo> TimeSyncAsync(CancellationToken cancellationToken)
    {
        try
        {
            var show = await runner.RunAsync(
                new ProcessSpec { Program = "timedatectl", Arguments = ["show"], Timeout = TimeSpan.FromSeconds(10) },
                onLine: null,
                cancellationToken);
            // is-active prints one state per unit, in order, and exits non-zero unless all are active.
            var active = await runner.RunAsync(
                new ProcessSpec { Program = "systemctl", Arguments = ["is-active", .. _timeServices], Timeout = TimeSpan.FromSeconds(10) },
                onLine: null,
                cancellationToken);
            var states = active.StandardOutput.Split('\n', StringSplitOptions.TrimEntries);
            var running = _timeServices.Where((_, i) => i < states.Length && states[i] == "active").FirstOrDefault();
            return SystemctlOutput.ParseTimeSync(show.StandardOutput, running?[..^".service".Length]);
        }
        catch (ProcessStartException)
        {
            return new TimeSyncInfo();
        }
    }

    private static string? FirstLine(string? text) =>
        text?.Split('\n', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries).FirstOrDefault();

    /// <summary>The names `uname -m` uses, which is what people know them by on a server.</summary>
    private static string MachineName(Architecture architecture) => architecture switch
    {
        Architecture.X64 => "x86_64",
        Architecture.Arm64 => "aarch64",
        Architecture.X86 => "i686",
        Architecture.Arm => "armv7l",
        _ => architecture.ToString().ToLowerInvariant(),
    };

    /// <summary>The server's interfaces as .NET reads them (sysfs and netlink on Linux), loopback aside.</summary>
    public static IReadOnlyList<NetworkInterfaceInfo> ReadNetworkInterfaces()
    {
        var interfaces = new List<NetworkInterfaceInfo>();
        foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
        {
            if (nic.NetworkInterfaceType == NetworkInterfaceType.Loopback)
            {
                continue;
            }

            string[] addresses;
            try
            {
                addresses = [.. nic.GetIPProperties().UnicastAddresses
                    .Select(unicast => unicast.Address)
                    .Where(address => address.AddressFamily is AddressFamily.InterNetwork
                        || (address.AddressFamily == AddressFamily.InterNetworkV6 && !address.IsIPv6LinkLocal))
                    .Select(address => address.ToString())];
            }
            catch (NetworkInformationException)
            {
                addresses = [];
            }

            var mac = nic.GetPhysicalAddress().GetAddressBytes();
            long? speed = nic.Speed > 0 ? nic.Speed / 1_000_000 : null;
            interfaces.Add(new NetworkInterfaceInfo(
                nic.Name,
                nic.OperationalStatus == OperationalStatus.Up,
                addresses,
                mac.Length == 6 ? string.Join(':', mac.Select(b => b.ToString("x2", System.Globalization.CultureInfo.InvariantCulture))) : null,
                speed));
        }

        return interfaces;
    }
}
