using System.Globalization;
using System.Text.Json;

namespace Runova.ServerCore.Stacks;

/// <summary>A published port as `docker compose config` writes it: long syntax, ranges expanded.</summary>
internal sealed record ComposeConfigPort(int Target, string Protocol, string? HostIp, string? Published);

internal sealed record ComposeConfigService(
    string Name,
    JsonElement Definition,
    string? Image,
    bool Builds,
    string? NetworkMode,
    IReadOnlyList<ComposeConfigPort> Ports);

/// <summary>
/// The output of `docker compose config --format json`, which is Compose's own reading of the
/// files with the environment substituted, paths made absolute and ports in long syntax. It holds
/// env values, so it lives in memory for one check and is never written anywhere.
/// </summary>
internal sealed class ComposeConfig : IDisposable
{
    private readonly JsonDocument _document;

    private ComposeConfig(JsonDocument document, IReadOnlyList<ComposeConfigService> services)
    {
        _document = document;
        Services = services;
    }

    public IReadOnlyList<ComposeConfigService> Services { get; }

    public JsonElement Root => _document.RootElement;

    public bool Builds => Services.Any(service => service.Builds);

    /// <summary>Reads the JSON, or says why it cannot be used.</summary>
    public static ComposeConfig Parse(string json)
    {
        ArgumentNullException.ThrowIfNull(json);
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 64 });
        }
        catch (JsonException)
        {
            throw new ComposeConfigException("docker compose config gave an answer the core could not read.");
        }

        try
        {
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                throw new ComposeConfigException("docker compose config gave an answer the core could not read.");
            }

            var services = new List<ComposeConfigService>();
            if (root.TryGetProperty("services", out var listed) && listed.ValueKind == JsonValueKind.Object)
            {
                foreach (var service in listed.EnumerateObject())
                {
                    if (!StackRules.IsServiceName(service.Name) || service.Value.ValueKind != JsonValueKind.Object)
                    {
                        throw new ComposeConfigException($"The service name {service.Name} can't be used.");
                    }

                    services.Add(new ComposeConfigService(
                        service.Name,
                        service.Value,
                        Text(service.Value, "image"),
                        service.Value.TryGetProperty("build", out var build) && build.ValueKind is JsonValueKind.Object or JsonValueKind.String,
                        Text(service.Value, "network_mode"),
                        ReadPorts(service.Name, service.Value)));
                }
            }

            if (services.Count == 0)
            {
                throw new ComposeConfigException("The compose file has no services.");
            }

            if (services.Count > StackRules.MaxServices)
            {
                throw new ComposeConfigException($"The compose file has more than {StackRules.MaxServices} services.");
            }

            return new ComposeConfig(document, services);
        }
        catch
        {
            document.Dispose();
            throw;
        }
    }

    public void Dispose() => _document.Dispose();

    public static string? Text(JsonElement element, string name) =>
        element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static List<ComposeConfigPort> ReadPorts(string service, JsonElement definition)
    {
        var ports = new List<ComposeConfigPort>();
        if (!definition.TryGetProperty("ports", out var list) || list.ValueKind != JsonValueKind.Array)
        {
            return ports;
        }

        foreach (var entry in list.EnumerateArray())
        {
            if (entry.ValueKind != JsonValueKind.Object
                || !entry.TryGetProperty("target", out var targetElement)
                || !TryPort(targetElement, out var target))
            {
                throw new ComposeConfigException($"A port of {service} could not be read from docker compose config.");
            }

            var protocol = Text(entry, "protocol") ?? "tcp";
            if (protocol is not ("tcp" or "udp" or "sctp"))
            {
                throw new ComposeConfigException($"A port of {service} uses the protocol {protocol}, which the core does not know.");
            }

            string? published = null;
            if (entry.TryGetProperty("published", out var publishedElement))
            {
                published = publishedElement.ValueKind switch
                {
                    JsonValueKind.String => publishedElement.GetString(),
                    JsonValueKind.Number => publishedElement.GetInt32().ToString(CultureInfo.InvariantCulture),
                    _ => null,
                };
                if (published is { Length: 0 })
                {
                    published = null;
                }

                if (published is not null && !IsPublished(published))
                {
                    throw new ComposeConfigException($"A port of {service} is published as {published}, which the core cannot read.");
                }
            }

            var hostIp = Text(entry, "host_ip");
            if (hostIp is { Length: 0 })
            {
                hostIp = null;
            }

            if (hostIp is not null && !System.Net.IPAddress.TryParse(hostIp, out _))
            {
                throw new ComposeConfigException($"A port of {service} is bound to {hostIp}, which is not an address.");
            }

            ports.Add(new ComposeConfigPort(target, protocol, hostIp, published));
        }

        return ports;
    }

    private static bool TryPort(JsonElement element, out int port)
    {
        port = 0;
        return element.ValueKind switch
        {
            JsonValueKind.Number => element.TryGetInt32(out port) && port is >= 1 and <= 65535,
            JsonValueKind.String => int.TryParse(element.GetString(), NumberStyles.None, CultureInfo.InvariantCulture, out port) && port is >= 1 and <= 65535,
            _ => false,
        };
    }

    /// <summary>A port, or a range Docker picks from ("8000-8010").</summary>
    private static bool IsPublished(string text)
    {
        var parts = text.Split('-');
        return parts.Length is 1 or 2
            && parts.All(part => int.TryParse(part, NumberStyles.None, CultureInfo.InvariantCulture, out var port) && port is >= 1 and <= 65535);
    }
}

/// <summary>docker compose config refused the files, or answered with something unusable.</summary>
internal sealed class ComposeConfigException(string message) : Exception(message);
