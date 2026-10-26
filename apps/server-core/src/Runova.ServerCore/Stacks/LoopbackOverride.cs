using System.Globalization;
using System.Text;
using Runova.ServerCore.Compatibility;
using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.Stacks;

/// <summary>
/// The override file that keeps services behind the proxy off the public interfaces, written
/// from Compose's own reading of the files (the app previews the same thing with
/// packages/core/src/deploy/compose/override.ts). Every port such a service publishes is bound to
/// 127.0.0.1, so nginx on the server reaches it and nothing outside does. It has to use Compose's
/// `!override` tag (Compose 2.24.4 or later): a plain override adds to `ports:`, so the original
/// binding on every interface would survive next to the loopback one.
/// </summary>
internal static class LoopbackOverride
{
    public const string FileName = "runova.override.yaml";

    /// <summary>
    /// The override in a revision folder: the new name, or the one revisions saved before the
    /// rename have (they are still started, rolled back to and restored from backups).
    /// </summary>
    public static string PathIn(string folder)
    {
        var path = Path.Combine(folder, FileName);
        var legacy = Path.Combine(folder, LegacyNames.LoopbackOverrideFile);
        return !File.Exists(path) && File.Exists(legacy) ? legacy : path;
    }

    public const string LoopbackAddress = "127.0.0.1";

    private const string Header =
        "# Written by Runova: services behind the proxy publish their ports on 127.0.0.1 only.\n"
        + "# !override replaces their ports rather than adding to them (Docker Compose 2.24.4 or later).\n";

    public sealed record Result(string? Text, IReadOnlyList<StackPortBinding> Bindings);

    public static bool IsLoopback(string? hostIp) =>
        hostIp is not null
        && (hostIp.StartsWith("127.", StringComparison.Ordinal) || hostIp == "::1" || hostIp.StartsWith("::ffff:127.", StringComparison.Ordinal));

    /// <summary>The override text (null when no proxied service publishes a port) and every binding once it applies.</summary>
    public static Result Render(ComposeConfig config, IReadOnlyCollection<string> proxiedServices)
    {
        ArgumentNullException.ThrowIfNull(config);
        ArgumentNullException.ThrowIfNull(proxiedServices);
        foreach (var name in proxiedServices)
        {
            if (config.Services.All(service => service.Name != name))
            {
                throw new ComposeConfigException($"There is no service called {name} in the compose file.");
            }
        }

        var text = new StringBuilder(Header).Append("services:\n");
        var written = false;
        var bindings = new List<StackPortBinding>();
        foreach (var service in config.Services)
        {
            var proxied = proxiedServices.Contains(service.Name);
            if (!proxied)
            {
                bindings.AddRange(service.Ports.Select(port => new StackPortBinding(service.Name, port.Target, port.Protocol, port.HostIp, port.Published)));
                continue;
            }

            if (service.NetworkMode == "host")
            {
                throw new ComposeConfigException(
                    $"{service.Name} uses network_mode: host, so it listens on the server's own addresses and has no ports to bind to 127.0.0.1. Remove network_mode: host to put it behind the proxy.");
            }

            if (service.Ports.Count == 0)
            {
                continue;
            }

            written = true;
            text.Append("  \"").Append(service.Name).Append("\":\n    ports: !override\n");
            foreach (var port in service.Ports)
            {
                bindings.Add(new StackPortBinding(service.Name, port.Target, port.Protocol, LoopbackAddress, port.Published));
                text.Append("      - target: ").Append(port.Target.ToString(CultureInfo.InvariantCulture)).Append('\n');
                if (port.Published is not null)
                {
                    text.Append("        published: \"").Append(port.Published).Append("\"\n");
                }

                text.Append("        host_ip: ").Append(LoopbackAddress).Append('\n');
                text.Append("        protocol: ").Append(port.Protocol).Append('\n');
            }
        }

        return new Result(written ? text.ToString() : null, bindings);
    }
}
