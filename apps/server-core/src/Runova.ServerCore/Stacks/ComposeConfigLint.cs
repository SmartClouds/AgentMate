using System.Text.Json;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Hosting;

namespace Runova.ServerCore.Stacks;

/// <summary>
/// The core's own look at what a compose file reaches past its containers, on Compose's reading
/// of it (`docker compose config`). It covers the findings that need an acknowledgment (critical,
/// high and medium) and builds their ids the way the app's linter does
/// (packages/core/src/deploy/compose/lint.ts: rule:service[:subject]), so what was acknowledged
/// in the app counts here. Where Compose's reading differs from the file as written (a `~` mount
/// becomes /root/...), the id differs too and the app shows the core's finding to acknowledge.
/// A mount of the core's own files is not a risk to acknowledge: it is refused.
/// </summary>
internal static class ComposeConfigLint
{
    private static readonly (string Key, string Rule, StackRiskSeverity Severity, string Message)[] _hostSettings =
    [
        ("privileged", "privileged", StackRiskSeverity.Critical, "{0} runs privileged."),
        ("pid", "host-pid", StackRiskSeverity.Critical, "{0} shares the server's process list (pid: host)."),
        ("network_mode", "host-network", StackRiskSeverity.High, "{0} uses the server's network directly (network_mode: host)."),
        ("ipc", "host-ipc", StackRiskSeverity.High, "{0} shares the server's shared memory (ipc: host)."),
        ("userns_mode", "host-userns", StackRiskSeverity.High, "{0} turns off user namespace remapping (userns_mode: host)."),
        ("uts", "host-uts", StackRiskSeverity.Medium, "{0} shares the server's hostname (uts: host)."),
        ("cgroup", "host-cgroup", StackRiskSeverity.Medium, "{0} uses the server's control groups (cgroup: host)."),
    ];

    private static readonly string[] _socketPaths =
    [
        "/run", "/var/run", "/run/docker.sock", "/var/run/docker.sock", "/run/docker", "/var/run/docker",
        "/run/containerd", "/var/run/containerd", "/run/podman", "/var/run/podman", "/run/crio", "/var/run/crio",
    ];

    /// <summary>Both layouts' folders: after a migration the old paths are links to the new ones.</summary>
    private static readonly string[] _corePaths =
    [
        .. new[] { CoreLayout.Runova, CoreLayout.Legacy }.SelectMany(layout => new[] { layout.DataDirectory, layout.ConfigDirectory, layout.Root, layout.RuntimeDirectory }),
    ];

    private static readonly string[] _sensitivePaths =
    [
        "/etc", "/proc", "/sys", "/dev", "/boot", "/root", "/home", "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64",
        "/libx32", "/var/lib", "/var/log", "/var/spool",
    ];

    private static readonly string[] _harmlessReadOnly = ["/etc/localtime", "/etc/timezone", "/usr/share/zoneinfo"];

    private static readonly HashSet<string> _defaultCapabilities = new(StringComparer.Ordinal)
    {
        "CHOWN", "DAC_OVERRIDE", "FSETID", "FOWNER", "MKNOD", "NET_RAW", "SETGID", "SETUID", "SETFCAP", "SETPCAP",
        "NET_BIND_SERVICE", "SYS_CHROOT", "KILL", "AUDIT_WRITE",
    };

    private static readonly HashSet<string> _escapeCapabilities = new(StringComparer.Ordinal)
    {
        "ALL", "SYS_ADMIN", "SYS_MODULE", "SYS_RAWIO", "SYS_PTRACE", "SYS_BOOT", "DAC_READ_SEARCH", "MAC_ADMIN", "MAC_OVERRIDE", "BPF",
    };

    private static readonly HashSet<string> _serverCapabilities = new(StringComparer.Ordinal)
    {
        "NET_ADMIN", "SYS_TIME", "SYSLOG", "SYS_RESOURCE", "LINUX_IMMUTABLE", "AUDIT_CONTROL", "AUDIT_READ", "IPC_OWNER",
        "WAKE_ALARM", "BLOCK_SUSPEND",
    };

    private static readonly Dictionary<string, string> _unconfined = new(StringComparer.Ordinal)
    {
        ["seccomp=unconfined"] = "turns off its system call filter (seccomp=unconfined)",
        ["apparmor=unconfined"] = "runs without an AppArmor profile (apparmor=unconfined)",
        ["label=disable"] = "turns off SELinux separation (label=disable)",
        ["label=type:spc_t"] = "runs as a super privileged SELinux container (spc_t)",
        ["systempaths=unconfined"] = "can see all of /proc and /sys (systempaths=unconfined)",
    };

    /// <summary>Whether a finding of this severity needs an acknowledgment before a deploy.</summary>
    public static bool NeedsAcknowledgment(StackRiskSeverity severity) => severity != StackRiskSeverity.Low;

    /// <param name="projectDirectory">The revision's files/ folder: bind mounts inside it are the app's own.</param>
    /// <param name="coreData">The core's data folder: a mount inside it (outside the project) is refused.</param>
    public static List<StackRisk> Lint(ComposeConfig config, IReadOnlyCollection<string> proxiedServices, string projectDirectory, string coreData)
    {
        ArgumentNullException.ThrowIfNull(config);
        ArgumentNullException.ThrowIfNull(proxiedServices);
        var project = Clean(projectDirectory);
        var core = Clean(coreData);
        var risks = new List<StackRisk>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        void Add(string rule, StackRiskSeverity severity, string service, string? subject, string message)
        {
            var id = subject is null ? $"{rule}:{service}" : $"{rule}:{service}:{subject}";
            if (seen.Add(id))
            {
                risks.Add(new StackRisk(id, rule, severity, message, service));
            }
        }

        foreach (var service in config.Services)
        {
            var definition = service.Definition;
            foreach (var (key, rule, severity, message) in _hostSettings)
            {
                if (!definition.TryGetProperty(key, out var value))
                {
                    continue;
                }

                var on = key == "privileged"
                    ? value.ValueKind == JsonValueKind.True || (value.ValueKind == JsonValueKind.String && value.GetString() == "true")
                    : value.ValueKind == JsonValueKind.String && value.GetString() == "host";
                if (on)
                {
                    Add(rule, severity, service.Name, null, string.Format(System.Globalization.CultureInfo.InvariantCulture, message, service.Name));
                }
            }

            foreach (var mount in Mounts(definition, config.Root))
            {
                var path = Clean(mount.Source);
                if (StackRules.Within(path, project))
                {
                    continue;
                }

                if (StackRules.Within(path, core))
                {
                    throw new ComposeConfigException(
                        $"{service.Name} mounts {mount.Source}, which is inside the core's own data. Keep bind mounts inside the app's files.");
                }

                var found = Classify(path, mount.ReadOnly);
                if (found is { } risk)
                {
                    var through = mount.Volume is null ? string.Empty : $" through the volume {mount.Volume}";
                    Add(risk.Rule, risk.Severity, service.Name, path, risk.Rule switch
                    {
                        "docker-socket" => $"{service.Name} mounts {path}{through}, which reaches the Docker socket.",
                        "host-root" => $"{service.Name} mounts the server's whole filesystem (/){through}.",
                        "core-data" => $"{service.Name} mounts {path}{through}, which holds Runova's own server files.",
                        _ => $"{service.Name} mounts the server folder {path}{(mount.ReadOnly ? " read-only" : string.Empty)}{through}.",
                    });
                }
            }

            foreach (var capability in Strings(definition, "cap_add"))
            {
                CapabilityRisk(service.Name, capability, Add);
            }

            foreach (var device in Items(definition, "devices"))
            {
                var path = device.ValueKind switch
                {
                    JsonValueKind.String => device.GetString()!.Split(':')[0],
                    JsonValueKind.Object => ComposeConfig.Text(device, "source"),
                    _ => null,
                };
                if (!string.IsNullOrEmpty(path))
                {
                    Add("devices", StackRiskSeverity.High, service.Name, path, $"{service.Name} gets direct access to the device {path}.");
                }
            }

            foreach (var rule in Strings(definition, "device_cgroup_rules"))
            {
                Add("device-cgroup-rule", StackRiskSeverity.High, service.Name, rule, $"{service.Name} is allowed devices by the rule \"{rule}\".");
            }

            foreach (var option in Strings(definition, "security_opt"))
            {
                var separator = option.IndexOfAny([':', '=']);
                var normalized = separator < 0 ? option : $"{option[..separator]}={option[(separator + 1)..]}";
                if (_unconfined.TryGetValue(normalized, out var text))
                {
                    Add("security-opt", StackRiskSeverity.High, service.Name, normalized, $"{service.Name} {text}.");
                }
            }

            if (!proxiedServices.Contains(service.Name))
            {
                foreach (var port in service.Ports)
                {
                    if (LoopbackOverride.IsLoopback(port.HostIp))
                    {
                        continue;
                    }

                    var where = port.HostIp ?? "every interface";
                    var asPort = port.Published is null ? "a port Docker picks" : $"port {port.Published}";
                    Add(
                        "public-port",
                        StackRiskSeverity.Medium,
                        service.Name,
                        $"{port.HostIp ?? "*"}:{port.Published ?? "any"}:{port.Target}/{port.Protocol}",
                        $"{service.Name} publishes {port.Target}/{port.Protocol} on {where} as {asPort}.");
                }
            }
        }

        return risks;
    }

    private sealed record Mount(string Source, bool ReadOnly, string? Volume);

    private static string Clean(string path) =>
        StackRules.CleanPath(OperatingSystem.IsWindows() ? path.Replace('\\', '/') : path);

    private static (string Rule, StackRiskSeverity Severity)? Classify(string path, bool readOnly)
    {
        if (!path.StartsWith('/'))
        {
            return null;
        }

        if (path == "/")
        {
            return ("host-root", StackRiskSeverity.Critical);
        }

        if (_socketPaths.Any(socket => StackRules.Within(path, socket)))
        {
            return ("docker-socket", StackRiskSeverity.Critical);
        }

        if (_corePaths.Any(core => StackRules.Within(path, core) || StackRules.Within(core, path)))
        {
            return ("core-data", StackRiskSeverity.Critical);
        }

        if (readOnly && _harmlessReadOnly.Any(harmless => StackRules.Within(path, harmless)))
        {
            return null;
        }

        return _sensitivePaths.Any(folder => StackRules.Within(path, folder))
            ? ("sensitive-mount", readOnly ? StackRiskSeverity.High : StackRiskSeverity.Critical)
            : null;
    }

    private static IEnumerable<Mount> Mounts(JsonElement definition, JsonElement root)
    {
        foreach (var entry in Items(definition, "volumes"))
        {
            if (entry.ValueKind == JsonValueKind.String)
            {
                // Compose writes the long syntax; a short entry is read as the app's linter reads it.
                var parts = entry.GetString()!.Split(':');
                if (parts.Length < 2 || parts[0].Length == 0)
                {
                    continue;
                }

                var readOnly = parts.Length > 2 && parts[2].Split(',').Contains("ro");
                if (parts[0][0] is '/' or '.' or '~')
                {
                    yield return new Mount(parts[0], readOnly, null);
                }
                else if (VolumeDevice(root, parts[0]) is { } device)
                {
                    yield return new Mount(device, readOnly, parts[0]);
                }

                continue;
            }

            if (entry.ValueKind != JsonValueKind.Object || ComposeConfig.Text(entry, "source") is not { } source)
            {
                continue;
            }

            var readOnlyEntry = entry.TryGetProperty("read_only", out var flag) && flag.ValueKind == JsonValueKind.True;
            var type = ComposeConfig.Text(entry, "type");
            if (type == "bind")
            {
                yield return new Mount(source, readOnlyEntry, null);
            }
            else if ((type is null or "volume") && VolumeDevice(root, source) is { } device)
            {
                yield return new Mount(device, readOnlyEntry, source);
            }
        }
    }

    /// <summary>A named volume that the local driver turns into a bind mount of a host folder.</summary>
    private static string? VolumeDevice(JsonElement root, string name)
    {
        if (!root.TryGetProperty("volumes", out var volumes) || volumes.ValueKind != JsonValueKind.Object
            || !volumes.TryGetProperty(name, out var volume) || volume.ValueKind != JsonValueKind.Object
            || !volume.TryGetProperty("driver_opts", out var options) || options.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        var driver = ComposeConfig.Text(volume, "driver");
        if (driver is not null && driver != "local")
        {
            return null;
        }

        var device = ComposeConfig.Text(options, "device");
        var o = ComposeConfig.Text(options, "o") ?? string.Empty;
        var binds = o.Split(',').Any(part => part.Trim() is "bind" or "rbind");
        return device is not null && binds ? device : null;
    }

    private static void CapabilityRisk(string service, string raw, Action<string, StackRiskSeverity, string, string?, string> add)
    {
        if (raw.Length == 0)
        {
            return;
        }

        var capability = raw.ToUpperInvariant();
        if (capability.StartsWith("CAP_", StringComparison.Ordinal))
        {
            capability = capability[4..];
        }

        var message = capability == "ALL" ? $"{service} adds every capability (cap_add: ALL)." : $"{service} adds the capability {capability}.";
        if (_escapeCapabilities.Contains(capability))
        {
            add("cap-add", StackRiskSeverity.Critical, service, capability, message);
        }
        else if (_serverCapabilities.Contains(capability))
        {
            add("cap-add", StackRiskSeverity.High, service, capability, message);
        }
        else if (!_defaultCapabilities.Contains(capability))
        {
            add("cap-add", StackRiskSeverity.Medium, service, capability, message);
        }
    }

    private static List<JsonElement> Items(JsonElement definition, string key)
    {
        if (!definition.TryGetProperty(key, out var value))
        {
            return [];
        }

        return value.ValueKind == JsonValueKind.Array ? [.. value.EnumerateArray()] : [value];
    }

    private static IEnumerable<string> Strings(JsonElement definition, string key) =>
        Items(definition, key).Where(item => item.ValueKind == JsonValueKind.String).Select(item => item.GetString()!);
}
