using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.Platform;

/// <summary>
/// `systemctl show` and `timedatectl show`: KEY=value lines, one block per unit separated by a
/// blank line, in the order the units were asked for. The property order inside a block is
/// systemd's own, so nothing here depends on it.
/// </summary>
internal static class SystemctlOutput
{
    public static IReadOnlyList<IReadOnlyDictionary<string, string>> ParseShow(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        var blocks = new List<IReadOnlyDictionary<string, string>>();
        Dictionary<string, string>? current = null;
        foreach (var raw in text.Split('\n'))
        {
            var line = raw.TrimEnd('\r');
            if (line.Length == 0)
            {
                current = null;
                continue;
            }

            var equals = line.IndexOf('=', StringComparison.Ordinal);
            if (equals <= 0)
            {
                continue;
            }

            if (current is null)
            {
                current = new Dictionary<string, string>(StringComparer.Ordinal);
                blocks.Add(current);
            }

            current[line[..equals]] = line[(equals + 1)..];
        }

        return blocks;
    }

    public static ServiceState StateOf(string loadState, string activeState, string subState)
    {
        ArgumentNullException.ThrowIfNull(subState);
        if (loadState == "not-found")
        {
            return ServiceState.NotInstalled;
        }

        return activeState switch
        {
            "active" => ServiceState.Active,
            "reloading" => ServiceState.Reloading,
            "inactive" => ServiceState.Inactive,
            "failed" => ServiceState.Failed,
            "activating" => ServiceState.Activating,
            "deactivating" => ServiceState.Deactivating,
            _ => ServiceState.Unknown,
        };
    }

    /// <param name="service">Which time daemon runs, if the caller could tell (timedatectl does not say).</param>
    public static TimeSyncInfo ParseTimeSync(string text, string? service)
    {
        var blocks = ParseShow(text);
        var fields = blocks.Count > 0 ? blocks[0] : new Dictionary<string, string>();
        return new TimeSyncInfo(
            YesNo(fields.GetValueOrDefault("NTPSynchronized")),
            YesNo(fields.GetValueOrDefault("NTP")),
            fields.GetValueOrDefault("Timezone") is { Length: > 0 } zone ? zone : null,
            service);
    }

    private static bool? YesNo(string? value) => value switch
    {
        "yes" => true,
        "no" => false,
        _ => null,
    };
}
