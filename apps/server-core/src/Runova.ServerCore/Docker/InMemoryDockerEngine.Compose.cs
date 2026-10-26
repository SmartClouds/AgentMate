using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.Docker;

/// <summary>A service as a pretend `docker compose up` creates it.</summary>
internal sealed record ComposeContainerSpec(
    string Service,
    string Image,
    IReadOnlyList<ContainerPort> Ports,
    IReadOnlyList<KeyValuePair<string, string>> Environment,
    IReadOnlyList<string> Volumes,
    bool HasHealthcheck);

/// <summary>
/// What the simulated docker compose (DevHost and tests) does to the pretend engine: a project's
/// containers created, replaced when their settings changed, started, stopped and removed, with
/// the compose labels, the events and the network and volumes a real project gets.
/// </summary>
internal sealed partial class InMemoryDockerEngine
{
    /// <summary>`up --detach --remove-orphans`: returns the names of the containers it created or replaced.</summary>
    public IReadOnlyList<string> ComposeUp(string project, IReadOnlyList<ComposeContainerSpec> services)
    {
        ArgumentNullException.ThrowIfNull(project);
        ArgumentNullException.ThrowIfNull(services);
        EnsureRunning();
        var changed = new List<string>();
        lock (_gate)
        {
            var network = $"{project}_default";
            if (_networks.All(n => n.Name != network))
            {
                _networks.Add(new NetworkEntry(network, "172.30.0.0/16", project));
            }

            foreach (var volume in services.SelectMany(s => s.Volumes).Distinct(StringComparer.Ordinal))
            {
                var name = $"{project}_{volume}";
                if (_volumes.All(v => v.Name != name))
                {
                    _volumes.Add(new VolumeEntry(name, NowMs, 0, project, Anonymous: false));
                }
            }

            foreach (var orphan in _containers.Where(c => c.Labels.GetValueOrDefault(ComposeProjectLabel) == project
                && services.All(s => s.Service != c.Labels.GetValueOrDefault(ComposeServiceLabel))).ToList())
            {
                _containers.Remove(orphan);
                Raise("container", "destroy", orphan);
            }

            foreach (var spec in services)
            {
                var name = $"{project}-{spec.Service}-1";
                var existing = _containers.FirstOrDefault(c => c.Name == name);
                if (existing is not null && existing.Image == spec.Image && existing.Ports.SequenceEqual(spec.Ports) && existing.Environment.SequenceEqual(spec.Environment))
                {
                    if (existing.State != ContainerState.Running)
                    {
                        existing.Start(NowMs);
                        Raise("container", "start", existing);
                    }

                    continue;
                }

                if (existing is not null)
                {
                    _containers.Remove(existing);
                    Raise("container", "destroy", existing);
                }

                var container = new Container(name, spec.Image, project, spec.Service, Kind.Api)
                {
                    Ports = spec.Ports,
                    Environment = spec.Environment,
                    Command = ["/docker-entrypoint.sh"],
                    Health = spec.HasHealthcheck ? ContainerHealth.Healthy : ContainerHealth.None,
                    Load = 0.02,
                    MemoryBase = 24L * 1024 * 1024,
                };
                var now = NowMs;
                container.Created(now);
                container.Start(now);
                _containers.Add(container);
                Raise("container", "create", container);
                Raise("container", "start", container);
                changed.Add(name);
            }
        }

        Changes.Enqueue($"compose-up {project}");
        return changed;
    }

    public IReadOnlyList<string> ComposeStop(string project) => ComposeEach(project, "stop", container =>
    {
        if (container.State is ContainerState.Running or ContainerState.Paused)
        {
            container.Exit(NowMs, 0);
            Raise("container", "die", container, ("exitCode", "0"));
            Raise("container", "stop", container);
        }
    });

    public IReadOnlyList<string> ComposeStart(string project) => ComposeEach(project, "start", container =>
    {
        if (container.State is not (ContainerState.Running or ContainerState.Paused))
        {
            container.Start(NowMs);
            Raise("container", "start", container);
        }
    });

    public IReadOnlyList<string> ComposeRestart(string project) => ComposeEach(project, "restart", container =>
    {
        if (container.State is ContainerState.Running or ContainerState.Paused)
        {
            container.Exit(NowMs, 0);
            Raise("container", "die", container, ("exitCode", "0"));
        }

        container.Start(NowMs);
        container.RestartCount++;
        Raise("container", "restart", container);
    });

    /// <summary>`down`: the containers and the network go; the volumes too when asked.</summary>
    public IReadOnlyList<string> ComposeDown(string project, bool removeVolumes)
    {
        ArgumentNullException.ThrowIfNull(project);
        EnsureRunning();
        List<string> removed;
        lock (_gate)
        {
            var containers = _containers.Where(c => c.Labels.GetValueOrDefault(ComposeProjectLabel) == project).ToList();
            foreach (var container in containers)
            {
                _containers.Remove(container);
                Raise("container", "destroy", container);
            }

            _networks.RemoveAll(n => n.Project == project);
            if (removeVolumes)
            {
                _volumes.RemoveAll(v => v.Project == project);
            }

            removed = [.. containers.Select(c => c.Name)];
        }

        Changes.Enqueue(removeVolumes ? $"compose-down-volumes {project}" : $"compose-down {project}");
        return removed;
    }

    /// <summary>The project's volumes by name, for tests that check what a down kept.</summary>
    public IReadOnlyList<string> VolumesOf(string project)
    {
        lock (_gate)
        {
            return [.. _volumes.Where(v => v.Project == project).Select(v => v.Name)];
        }
    }

    private const string ComposeProjectLabel = "com.docker.compose.project";

    private const string ComposeServiceLabel = "com.docker.compose.service";

    private List<string> ComposeEach(string project, string what, Action<Container> change)
    {
        ArgumentNullException.ThrowIfNull(project);
        EnsureRunning();
        List<string> names;
        lock (_gate)
        {
            var containers = _containers.Where(c => c.Labels.GetValueOrDefault(ComposeProjectLabel) == project).ToList();
            foreach (var container in containers)
            {
                change(container);
            }

            names = [.. containers.Select(c => c.Name)];
        }

        Changes.Enqueue($"compose-{what} {project}");
        return names;
    }
}
