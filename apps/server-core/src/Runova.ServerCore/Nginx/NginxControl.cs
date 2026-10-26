using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Execution;

namespace Runova.ServerCore.Nginx;

internal enum NginxStreamModule
{
    None,
    BuiltIn,
    Dynamic,
}

/// <summary>What nginx -V and the files around it say.</summary>
internal sealed record NginxInspection(
    bool Installed,
    Version? Version,
    bool Running,
    bool FromNginxOrg,
    NginxStreamModule StreamModule,
    bool HttpWired,
    bool StreamWired,
    int? CurrentRelease,
    bool SeLinuxEnabled,
    bool IPv6,
    string ConfPath,
    string PidPath)
{
    public bool Managed => HttpWired && CurrentRelease is not null;

    public static NginxInspection Missing(bool seLinux, bool ipv6) =>
        new(false, null, false, false, NginxStreamModule.None, false, false, null, seLinux, ipv6, NginxControl.DefaultConfPath, NginxControl.DefaultPidPath);
}

/// <summary>A reload, confirmed by new worker processes, or the reason nginx kept the old configuration.</summary>
internal sealed record NginxReloadOutcome(bool Confirmed, string Error);

/// <summary>
/// Looks at nginx and drives it: inspection, nginx -t, and reloads that are confirmed rather than
/// assumed. nginx -s reload only sends a signal and exits 0; whether the master took the new
/// configuration shows in its workers (a reload starts new ones) and, when it did not, in error.log.
/// </summary>
internal sealed partial class NginxControl(INginxMachine machine, TimeProvider time)
{
    public const string DefaultConfPath = "/etc/nginx/nginx.conf";
    public const string DefaultPidPath = "/run/nginx.pid";

    private static readonly TimeSpan _commandTimeout = TimeSpan.FromSeconds(60);

    public TimeSpan ReloadDeadline { get; init; } = TimeSpan.FromSeconds(20);

    public TimeSpan PollInterval { get; init; } = TimeSpan.FromMilliseconds(200);

    /// <summary>
    /// How long error.log has to stay as it is, once it shows a refused reload, before that reload
    /// counts as over. nginx tries a bind() in use five times, 500 ms apart, writing the error each
    /// time; stopping at the first line left the rest to land after the next reload's signal,
    /// where it read as that reload's cause.
    /// </summary>
    public TimeSpan SettleTime { get; init; } = TimeSpan.FromSeconds(1);

    public INginxMachine Machine => machine;

    /// <summary>
    /// The layout for this server: the OS family's paths, the names an nginx set up before the
    /// rename already uses, and IPv6 only where the host has it.
    /// </summary>
    public static NginxLayout LayoutFor(OsFamily family, NginxInspection inspection, bool? legacyNames = null)
    {
        ArgumentNullException.ThrowIfNull(inspection);
        var layout = family == OsFamily.Rhel ? NginxLayout.Rhel : NginxLayout.Debian;
        if (legacyNames ?? NginxLayout.LegacyNamesHere)
        {
            layout = layout.WithLegacyNames();
        }

        return layout with { ListenIPv6 = inspection.IPv6 };
    }

    public async Task<NginxInspection> InspectAsync(NginxLayout layout, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(layout);
        var seLinux = await machine.ExistsAsync("/sys/fs/selinux/enforce", cancellationToken);
        var ipv6 = (await machine.ReadTextAsync("/proc/net/if_inet6", cancellationToken) ?? string.Empty)
            .Split('\n')
            .Any(line => line.StartsWith("00000000000000000000000000000001 ", StringComparison.Ordinal));

        ProcessResult details;
        try
        {
            details = await machine.RunAsync(Nginx("-V"), cancellationToken);
        }
        catch (ProcessStartException)
        {
            return NginxInspection.Missing(seLinux, ipv6);
        }

        var text = details.StandardError + details.StandardOutput;
        var version = NginxRepository.ParseVersion(text);
        if (!details.Succeeded || version is null)
        {
            return NginxInspection.Missing(seLinux, ipv6);
        }

        var stream = text.Contains("--with-stream=dynamic", StringComparison.Ordinal) ? NginxStreamModule.Dynamic
            : StreamBuiltIn().IsMatch(text) ? NginxStreamModule.BuiltIn
            : NginxStreamModule.None;
        var confPath = Option(text, "--conf-path") ?? DefaultConfPath;
        var pidPath = Option(text, "--pid-path") ?? DefaultPidPath;
        var conf = await machine.ReadTextAsync(confPath, cancellationToken) ?? string.Empty;
        var (http, streamWired) = NginxConfWiring.IsWired(conf, layout);
        var fromNginxOrg = await machine.ExistsAsync(NginxRepository.DebianSourcesPath, cancellationToken)
            || await machine.ExistsAsync(NginxRepository.RhelRepoPath, cancellationToken);
        return new NginxInspection(
            true,
            version,
            await MasterPidAsync(pidPath, cancellationToken) is not null,
            fromNginxOrg,
            stream,
            http,
            streamWired,
            await CurrentReleaseAsync(layout, cancellationToken),
            seLinux,
            ipv6,
            confPath,
            pidPath);
    }

    /// <summary>The release the current link points at, or null when there is no link of ours.</summary>
    public async Task<int?> CurrentReleaseAsync(NginxLayout layout, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(layout);
        var target = await machine.ReadLinkAsync(layout.CurrentLink, cancellationToken);
        return ReleaseOf(target);
    }

    /// <summary>"releases/12" (or the absolute path) as 12.</summary>
    public static int? ReleaseOf(string? target)
    {
        if (target is null)
        {
            return null;
        }

        var name = target.TrimEnd('/');
        name = name[(name.LastIndexOf('/') + 1)..];
        return int.TryParse(name, NumberStyles.None, CultureInfo.InvariantCulture, out var number) ? number : null;
    }

    public Task<ProcessResult> TestAsync(CancellationToken cancellationToken) => machine.RunAsync(Nginx("-t"), cancellationToken);

    /// <summary>
    /// Reloads, or starts nginx when it is not running, and waits until new workers serve the new
    /// configuration. When none come, error.log since the signal says why.
    /// </summary>
    public async Task<NginxReloadOutcome> ReloadAsync(NginxInspection inspection, NginxLayout layout, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(inspection);
        ArgumentNullException.ThrowIfNull(layout);
        var errorLog = layout.ErrorLogFile;
        var offset = await machine.LengthAsync(errorLog, cancellationToken) ?? 0;
        var master = await MasterPidAsync(inspection.PidPath, cancellationToken);
        if (master is null)
        {
            var start = await machine.RunAsync(
                new ProcessSpec { Program = "systemctl", Arguments = ["start", "nginx.service"], Timeout = TimeSpan.FromSeconds(90) },
                cancellationToken);
            if (!start.Succeeded || await MasterPidAsync(inspection.PidPath, cancellationToken) is null)
            {
                return new NginxReloadOutcome(false, await ReadSinceAsync(errorLog, offset, cancellationToken) is { Length: > 0 } log
                    ? log
                    : $"nginx did not start: {FirstLine(start.StandardError) ?? $"exit code {start.ExitCode}"}");
            }

            return new NginxReloadOutcome(true, string.Empty);
        }

        var before = await WorkersAsync(master.Value, cancellationToken);
        var signal = await machine.RunAsync(Nginx("-s", "reload"), cancellationToken);
        if (!signal.Succeeded)
        {
            return new NginxReloadOutcome(false, signal.StandardError.Trim() is { Length: > 0 } reason ? reason : $"nginx -s reload exited with code {signal.ExitCode}.");
        }

        var deadline = time.GetUtcNow() + ReloadDeadline;
        string? refusal = null;
        var unchangedSince = DateTimeOffset.MinValue;
        while (true)
        {
            if (refusal is null)
            {
                var now = await WorkersAsync(master.Value, cancellationToken);
                if (now.Any(pid => !before.Contains(pid)))
                {
                    return new NginxReloadOutcome(true, string.Empty);
                }
            }

            var log = await ReadSinceAsync(errorLog, offset, cancellationToken);
            var at = time.GetUtcNow();
            if (refusal is null ? NginxErrorInLog().IsMatch(log) : log.Length != refusal.Length)
            {
                (refusal, unchangedSince) = (log, at);
            }

            // Refused: over once nginx has stopped writing about it, so none of it is left for the next reload.
            if ((refusal is not null && at - unchangedSince >= SettleTime) || at >= deadline)
            {
                return new NginxReloadOutcome(false, log.Length > 0 ? log : "nginx started no new workers after the reload signal, so it kept the old configuration.");
            }

            await Task.Delay(PollInterval, time, cancellationToken);
        }
    }

    /// <summary>The master's pid when its pid file names a live process.</summary>
    public async Task<int?> MasterPidAsync(string pidPath, CancellationToken cancellationToken)
    {
        var text = (await machine.ReadTextAsync(pidPath, cancellationToken))?.Trim();
        return int.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var pid) && pid > 0
            && await machine.ExistsAsync($"/proc/{pid}/stat", cancellationToken)
            ? pid
            : null;
    }

    /// <summary>The master's children, from /proc (the children file, or a scan of every process's parent).</summary>
    public async Task<IReadOnlySet<int>> WorkersAsync(int master, CancellationToken cancellationToken)
    {
        var path = string.Create(CultureInfo.InvariantCulture, $"/proc/{master}/task/{master}/children");
        if (await machine.ReadTextAsync(path, cancellationToken) is { } children)
        {
            return children.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Select(pid => int.TryParse(pid, NumberStyles.None, CultureInfo.InvariantCulture, out var value) ? value : 0)
                .Where(pid => pid > 0)
                .ToHashSet();
        }

        var found = new HashSet<int>();
        foreach (var name in await machine.ListAsync("/proc", cancellationToken))
        {
            if (int.TryParse(name, NumberStyles.None, CultureInfo.InvariantCulture, out var pid)
                && await machine.ReadTextAsync($"/proc/{name}/stat", cancellationToken) is { } stat
                && ParentOf(stat) == master)
            {
                found.Add(pid);
            }
        }

        return found;
    }

    private async Task<string> ReadSinceAsync(string path, long offset, CancellationToken cancellationToken)
    {
        var length = await machine.LengthAsync(path, cancellationToken);
        if (length is null)
        {
            return string.Empty;
        }

        // A rotated log starts over; then everything in the new one is new.
        var from = length < offset ? 0 : offset;
        var bytes = await machine.ReadRangeAsync(path, from, 64 * 1024, cancellationToken);
        return Encoding.UTF8.GetString(bytes);
    }

    /// <summary>The fourth field of /proc/pid/stat; the name in parentheses may hold spaces.</summary>
    private static int? ParentOf(string stat)
    {
        var close = stat.LastIndexOf(')');
        var fields = close < 0 ? [] : stat[(close + 1)..].Split(' ', StringSplitOptions.RemoveEmptyEntries);
        return fields.Length > 1 && int.TryParse(fields[1], NumberStyles.None, CultureInfo.InvariantCulture, out var parent) ? parent : null;
    }

    private static string? Option(string text, string name)
    {
        var match = Regex.Match(text, Regex.Escape(name) + "=(\\S+)", RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));
        return match.Success ? match.Groups[1].Value : null;
    }

    private static string? FirstLine(string text) =>
        text.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).FirstOrDefault();

    private static ProcessSpec Nginx(params string[] arguments) =>
        new() { Program = "nginx", Arguments = arguments, Timeout = _commandTimeout, MaxOutputBytes = 256 * 1024 };

    [GeneratedRegex(@"--with-stream(?:\s|$)", RegexOptions.CultureInvariant)]
    private static partial Regex StreamBuiltIn();

    [GeneratedRegex(@"\[(?:emerg|alert|crit)\]", RegexOptions.CultureInvariant)]
    private static partial Regex NginxErrorInLog();
}
