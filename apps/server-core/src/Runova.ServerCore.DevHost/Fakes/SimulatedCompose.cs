using System.Collections.Concurrent;
using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Docker;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Registries;
using Runova.ServerCore.Stacks;
using YamlDotNet.RepresentationModel;

namespace Runova.ServerCore.DevHost.Fakes;

/// <summary>
/// docker compose on the pretend server (DevHost and the core's tests): it reads the uploaded
/// compose file, the loopback override (with !override) and the .env much as Compose does, answers
/// `config --format json` in Compose's shape (long-syntax ports with ranges expanded, absolute
/// paths, `$` doubled in values), and makes `up`, `start`, `stop`, `restart` and `down` happen to
/// the pretend Docker Engine, printing the lines the real one prints, a few a second.
/// </summary>
internal sealed partial class SimulatedCompose(InMemoryDockerEngine engine, TimeProvider time) : IComposeRunner
{
    public const string DefaultVersion = "2.39.4";

    /// <summary>Between output lines; the tests make it zero.</summary>
    public TimeSpan LineDelay { get; init; } = TimeSpan.FromMilliseconds(250);

    /// <summary>What `docker compose version --short` says; null pretends Compose is missing.</summary>
    public string? Version { get; set; } = DefaultVersion;

    /// <summary>Commands that fail with an error from the daemon ("pull"), for tests of failed deploys.</summary>
    public ConcurrentDictionary<string, bool> Failing { get; } = new(StringComparer.Ordinal);

    /// <summary>Every call, "project command args...", so a test can prove what ran.</summary>
    public ConcurrentQueue<string> Calls { get; } = new();

    /// <summary>
    /// What each call's DOCKER_CONFIG folder held when it ran (E08): its path and config.json, or
    /// null without one. The registry tests read it to prove the sign-ins were there for the pull.
    /// </summary>
    public ConcurrentQueue<(string Command, string? Folder, string? Config)> DockerConfigs { get; } = new();

    public Task<string?> VersionAsync(CancellationToken cancellationToken) => Task.FromResult(Version);

    public async Task<ProcessResult> RunAsync(
        ComposeProject project,
        IReadOnlyList<string> arguments,
        ComposeRunOptions options,
        Action<OutputLine>? onLine,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(project);
        ArgumentNullException.ThrowIfNull(arguments);
        var command = arguments.Count > 0 ? arguments[0] : string.Empty;
        Calls.Enqueue($"{project.Name} {string.Join(' ', arguments)}");
        var dockerConfig = options?.Environment is { } environment && environment.TryGetValue("DOCKER_CONFIG", out var folder) ? folder : null;
        var configFile = dockerConfig is null ? null : Path.Combine(dockerConfig, RegistryAuthFolders.ConfigFileName);
        DockerConfigs.Enqueue((command, dockerConfig, configFile is not null && File.Exists(configFile) ? File.ReadAllText(configFile) : null));
        var errors = new StringBuilder();
        var output = new StringBuilder();
        async Task Say(string line)
        {
            if (LineDelay > TimeSpan.Zero)
            {
                await Task.Delay(LineDelay, time, cancellationToken);
            }

            errors.Append(line).Append('\n');
            onLine?.Invoke(new OutputLine(OutputStream.Err, line));
        }

        JsonObject model;
        try
        {
            model = Load(project);
        }
        catch (Exception error) when (error is YamlDotNet.Core.YamlException or InvalidDataException or FormatException)
        {
            var message = $"validating {project.Files[0]}: {error.Message}";
            onLine?.Invoke(new OutputLine(OutputStream.Err, message));
            return new ProcessResult(15, string.Empty, message, false, false);
        }

        var services = model["services"]?.AsObject() ?? [];
        if (Failing.ContainsKey(command))
        {
            await Say($"Error response from daemon: simulated failure of {command}");
            return new ProcessResult(1, string.Empty, errors.ToString(), false, false);
        }

        switch (command)
        {
            case "config":
                if (!arguments.Contains("--quiet"))
                {
                    output.Append(model.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
                }

                break;
            case "pull":
                foreach (var (name, service) in services)
                {
                    if (service?["build"] is not null)
                    {
                        await Say($" {name} Skipped - No image to be pulled");
                        continue;
                    }

                    var image = service?["image"]?.GetValue<string>() ?? name;
                    await Say($" {name} Pulling");
                    var registry = DockerNames.TryParseReference(image, out var reference) ? RegistryNames.HostOfRepository(reference.Repository) : RegistryNames.DockerHub;
                    if (!engine.SignedInWith(registry, dockerConfig))
                    {
                        await Say($" {name} Error Head \"https://{registry}/v2/{reference.Repository}/manifests/{reference.Tag ?? "latest"}\": unauthorized: authentication required");
                        await Say($"Error response from daemon: Head \"https://{registry}/v2/{reference.Repository}/manifests/{reference.Tag ?? "latest"}\": unauthorized: authentication required");
                        return new ProcessResult(18, string.Empty, errors.ToString(), false, false);
                    }

                    await Say($" {name} Pulled");
                }

                break;
            case "build":
                foreach (var (name, service) in services.Where(s => s.Value?["build"] is not null))
                {
                    await Say($"#1 [{name} internal] load build definition from Dockerfile");
                    await Say($"#2 [{name} 1/2] FROM docker.io/library/alpine:3.22");
                    await Say($"#3 [{name}] exporting to image");
                    await Say($" {name} Built");
                }

                break;
            case "up":
                await Say($" Network {project.Name}_default  Creating");
                await Say($" Network {project.Name}_default  Created");
                var changed = engine.ComposeUp(project.Name, [.. services.Select(s => Spec(project.Name, s.Key, s.Value!.AsObject()))]);
                foreach (var name in changed)
                {
                    await Say($" Container {name}  Created");
                }

                foreach (var name in services.Select(s => $"{project.Name}-{s.Key}-1"))
                {
                    await Say($" Container {name}  Started");
                    await Say($" Container {name}  Healthy");
                }

                break;
            case "start" or "stop" or "restart":
                var names = command switch
                {
                    "start" => engine.ComposeStart(project.Name),
                    "stop" => engine.ComposeStop(project.Name),
                    _ => engine.ComposeRestart(project.Name),
                };
                foreach (var name in names)
                {
                    await Say($" Container {name}  {command switch { "start" => "Started", "stop" => "Stopped", _ => "Restarted" }}");
                }

                break;
            case "down":
                foreach (var name in engine.ComposeDown(project.Name, arguments.Contains("--volumes")))
                {
                    await Say($" Container {name}  Removed");
                }

                await Say($" Network {project.Name}_default  Removed");
                break;
            default:
                return new ProcessResult(1, string.Empty, $"unknown docker command: \"compose {command}\"", false, false);
        }

        return new ProcessResult(0, output.ToString(), errors.ToString(), false, false);
    }

    private static ComposeContainerSpec Spec(string project, string name, JsonObject service)
    {
        var ports = new List<ContainerPort>();
        var next = 32768;
        foreach (var port in service["ports"]?.AsArray() ?? [])
        {
            var target = int.Parse(port!["target"]!.ToString(), CultureInfo.InvariantCulture);
            var published = port["published"]?.ToString();
            var hostPort = published is null ? next++ : int.Parse(published.Split('-')[0], CultureInfo.InvariantCulture);
            ports.Add(new ContainerPort(target, port["protocol"]?.GetValue<string>() ?? "tcp", port["host_ip"]?.GetValue<string>() ?? "0.0.0.0", hostPort));
        }

        var environment = (service["environment"]?.AsObject() ?? [])
            .Select(entry => new KeyValuePair<string, string>(entry.Key, (entry.Value?.GetValue<string>() ?? string.Empty).Replace("$$", "$", StringComparison.Ordinal)))
            .ToList();
        var volumes = (service["volumes"]?.AsArray() ?? [])
            .Where(volume => volume?["type"]?.GetValue<string>() == "volume")
            .Select(volume => volume!["source"]!.GetValue<string>())
            .ToList();
        var health = service["healthcheck"] is JsonObject check && check["disable"]?.GetValue<bool>() != true;
        var image = service["image"]?.GetValue<string>() ?? $"{project}-{name}";
        return new ComposeContainerSpec(name, image, ports, environment, volumes, health);
    }

    /// <summary>The files merged as Compose merges them, interpolated and normalized.</summary>
    private static JsonObject Load(ComposeProject project)
    {
        var environment = new Dictionary<string, string>(StringComparer.Ordinal);
        if (File.Exists(project.EnvFile))
        {
            var parsed = ComposeEnvFile.Parse(File.ReadAllText(project.EnvFile));
            if (!parsed.Ok)
            {
                throw new InvalidDataException($"failed to read {project.EnvFile}: {parsed.Problem}");
            }

            foreach (var (key, value) in parsed.Entries)
            {
                environment[key] = value;
            }
        }

        JsonObject? merged = null;
        foreach (var file in project.Files)
        {
            var stream = new YamlStream();
            using (var reader = new StringReader(File.ReadAllText(file)))
            {
                stream.Load(reader);
            }

            if (stream.Documents.Count == 0 || stream.Documents[0].RootNode is not YamlMappingNode root)
            {
                throw new InvalidDataException("Top-level object must be a mapping");
            }

            var converted = (JsonObject)Convert(root, environment)!;
            merged = merged is null ? converted : Merge(merged, converted);
        }

        var model = merged ?? [];
        model["name"] = project.Name;
        var services = model["services"] as JsonObject ?? throw new InvalidDataException("services must be a mapping");
        foreach (var (_, value) in services)
        {
            if (value is JsonObject service)
            {
                Normalize(service, project.ProjectDirectory);
            }
        }

        return model;
    }

    /// <summary>Maps merge, lists add up, `!override` (kept as a marker) replaces.</summary>
    private static JsonObject Merge(JsonObject into, JsonObject from)
    {
        foreach (var (key, value) in from.ToList())
        {
            from.Remove(key);
            if (value is JsonObject marker && marker.ContainsKey(OverrideMarker))
            {
                into[key] = marker[OverrideMarker]!.DeepClone();
            }
            else if (value is JsonObject map && into[key] is JsonObject existing)
            {
                into[key] = Merge(existing, map);
            }
            else if (value is JsonArray list && into[key] is JsonArray existingList)
            {
                foreach (var item in list.ToList())
                {
                    list.Remove(item);
                    existingList.Add(item);
                }
            }
            else
            {
                into[key] = value;
            }
        }

        return into;
    }

    private const string OverrideMarker = "\u0000override";

    private static JsonNode? Convert(YamlNode node, Dictionary<string, string> environment)
    {
        JsonNode? converted = node switch
        {
            YamlMappingNode map => ConvertMap(map, environment),
            YamlSequenceNode list => new JsonArray([.. list.Children.Select(child => Convert(child, environment))]),
            YamlScalarNode scalar => ConvertScalar(scalar, environment),
            _ => throw new InvalidDataException("YAML aliases are not supported here."),
        };
        return !node.Tag.IsEmpty && node.Tag.Value == "!override" ? new JsonObject { [OverrideMarker] = converted } : converted;
    }

    private static JsonObject ConvertMap(YamlMappingNode map, Dictionary<string, string> environment)
    {
        var result = new JsonObject();
        foreach (var (key, value) in map.Children)
        {
            if (!value.Tag.IsEmpty && value.Tag.Value == "!reset")
            {
                continue;
            }

            result[((YamlScalarNode)key).Value!] = Convert(value, environment);
        }

        return result;
    }

    private static JsonValue? ConvertScalar(YamlScalarNode scalar, Dictionary<string, string> environment)
    {
        var text = scalar.Value ?? string.Empty;
        if (scalar.Style == YamlDotNet.Core.ScalarStyle.Plain)
        {
            if (text is "true" or "false")
            {
                return JsonValue.Create(text == "true");
            }

            if (text is "null" or "~" or "")
            {
                return null;
            }

            if (long.TryParse(text, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var number))
            {
                return JsonValue.Create(number);
            }
        }

        return JsonValue.Create(Interpolate(text, environment).Replace("$", "$$", StringComparison.Ordinal));
    }

    /// <summary>
    /// `$$`, `${NAME}`, `${NAME:-default}`, `${NAME-default}`, `${NAME:?error}`, `${NAME?error}` and
    /// `$NAME`, as Compose reads them. A required variable that is missing fails the whole read.
    /// </summary>
    private static string Interpolate(string text, Dictionary<string, string> environment) =>
        Variable().Replace(text, match =>
        {
            if (match.Value == "$$")
            {
                return "$";
            }

            var name = match.Groups["braced"].Success ? match.Groups["braced"].Value : match.Groups["plain"].Value;
            var found = environment.TryGetValue(name, out var value);
            if (match.Groups["fallback"].Success)
            {
                var op = match.Groups["op"].Value;
                var emptyCounts = op.StartsWith(':');
                var usable = found && (!emptyCounts || value!.Length > 0);
                if (op.EndsWith('?'))
                {
                    return usable
                        ? value!
                        : throw new InvalidDataException($"required variable {name} is missing a value: {match.Groups["fallback"].Value}");
                }

                return usable ? value! : match.Groups["fallback"].Value;
            }

            return found ? value! : string.Empty;
        });

    private static void Normalize(JsonObject service, string projectDirectory)
    {
        if (service["build"] is JsonValue context)
        {
            service["build"] = new JsonObject { ["context"] = Absolute(projectDirectory, context.GetValue<string>()), ["dockerfile"] = "Dockerfile" };
        }
        else if (service["build"] is JsonObject build)
        {
            build["context"] = Absolute(projectDirectory, build["context"]?.GetValue<string>() ?? ".");
            build["dockerfile"] ??= "Dockerfile";
        }

        if (service["ports"] is JsonArray ports)
        {
            service["ports"] = new JsonArray([.. ports.SelectMany(port => LongPorts(port))]);
        }

        if (service["volumes"] is JsonArray volumes)
        {
            service["volumes"] = new JsonArray([.. volumes.Select(volume => LongVolume(volume, projectDirectory))]);
        }

        if (service["environment"] is JsonArray list)
        {
            var map = new JsonObject();
            foreach (var item in list)
            {
                var entry = item?.ToString() ?? string.Empty;
                var equals = entry.IndexOf('=', StringComparison.Ordinal);
                map[equals < 0 ? entry : entry[..equals]] = equals < 0 ? string.Empty : entry[(equals + 1)..];
            }

            service["environment"] = map;
        }
        else if (service["environment"] is JsonObject environment)
        {
            foreach (var (key, value) in environment.ToList())
            {
                environment[key] = value?.ToString() ?? string.Empty;
            }
        }
    }

    private static string Absolute(string projectDirectory, string path) =>
        path.StartsWith('~') ? "/root" + path[1..]
        : path.StartsWith('/') || Path.IsPathRooted(path) ? path
        : Path.GetFullPath(Path.Combine(projectDirectory, path));

    private static IEnumerable<JsonObject> LongPorts(JsonNode? port)
    {
        if (port is JsonObject entry)
        {
            var copy = (JsonObject)entry.DeepClone();
            copy["mode"] ??= "ingress";
            copy["protocol"] ??= "tcp";
            if (copy["published"] is JsonValue published)
            {
                copy["published"] = published.ToString();
            }

            yield return copy;
            yield break;
        }

        var text = port?.ToString() ?? string.Empty;
        var protocol = "tcp";
        var slash = text.IndexOf('/', StringComparison.Ordinal);
        if (slash >= 0)
        {
            protocol = text[(slash + 1)..];
            text = text[..slash];
        }

        string? hostIp = null;
        if (text.StartsWith('['))
        {
            var close = text.IndexOf(']', StringComparison.Ordinal);
            hostIp = text[1..close];
            text = text[(close + 2)..];
        }

        var parts = text.Split(':');
        if (parts.Length == 3)
        {
            hostIp = parts[0];
            parts = parts[1..];
        }

        var (targetStart, targetEnd) = Range(parts[^1]);
        (int Start, int End)? hosts = parts.Length == 2 && parts[0].Length > 0 ? Range(parts[0]) : null;
        for (var offset = 0; offset <= targetEnd - targetStart; offset++)
        {
            var result = new JsonObject { ["mode"] = "ingress" };
            if (hostIp is { Length: > 0 })
            {
                result["host_ip"] = hostIp;
            }

            result["target"] = targetStart + offset;
            if (hosts is { } range)
            {
                result["published"] = targetEnd == targetStart && range.End != range.Start
                    ? $"{range.Start}-{range.End}"
                    : (range.Start + offset).ToString(CultureInfo.InvariantCulture);
            }

            result["protocol"] = protocol;
            yield return result;
        }
    }

    private static (int Start, int End) Range(string text)
    {
        var parts = text.Split('-');
        var start = int.Parse(parts[0], CultureInfo.InvariantCulture);
        return (start, parts.Length > 1 ? int.Parse(parts[1], CultureInfo.InvariantCulture) : start);
    }

    private static JsonObject LongVolume(JsonNode? volume, string projectDirectory)
    {
        if (volume is JsonObject entry)
        {
            var copy = (JsonObject)entry.DeepClone();
            if (copy["type"]?.GetValue<string>() == "bind" && copy["source"] is JsonValue source)
            {
                copy["source"] = Absolute(projectDirectory, source.GetValue<string>());
            }

            return copy;
        }

        var parts = (volume?.ToString() ?? string.Empty).Split(':');
        var bind = parts[0].Length > 0 && parts[0][0] is '.' or '/' or '~';
        var result = new JsonObject
        {
            ["type"] = bind ? "bind" : "volume",
            ["source"] = bind ? Absolute(projectDirectory, parts[0]) : parts[0],
            ["target"] = parts.Length > 1 ? parts[1] : parts[0],
        };
        if (parts.Length > 2 && parts[2].Split(',').Contains("ro"))
        {
            result["read_only"] = true;
        }

        if (bind)
        {
            result["bind"] = new JsonObject { ["create_host_path"] = true };
        }

        return result;
    }

    [GeneratedRegex(@"\$\$|\$\{(?<braced>[A-Za-z_][A-Za-z0-9_]*)(?:(?<op>:?[-?])(?<fallback>[^}]*))?\}|\$(?<plain>[A-Za-z_][A-Za-z0-9_]*)", RegexOptions.CultureInvariant)]
    private static partial Regex Variable();
}
