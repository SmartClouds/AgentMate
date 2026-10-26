using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Channels;
using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.Docker;

/// <summary>
/// A pretend Docker Engine for the DevHost (UI work on Windows and macOS) and the hub tests: two
/// compose projects and two standalone containers, stats that move, logs that grow, consoles with
/// a small shell, images, volumes and networks, and the events every change raises. Nothing here
/// touches a real engine. It lives in the core next to InMemoryAcme so both hosts share one.
/// </summary>
internal sealed partial class InMemoryDockerEngine : IDockerEngine, IDisposable
{
    public const string EngineVersionText = "29.1.3";

    /// <summary>Planted in the pretend containers' environments, so redaction can be seen working.</summary>
    public const string DatabasePassword = "pg-secret-7c41d2";

    public const string ApiToken = "tok-live-5f2e9a71c3";

    private const long Gigabyte = 1024L * 1024 * 1024;

    private readonly TimeProvider _time;
    private readonly Lock _gate = new();
    private readonly List<Container> _containers = [];
    private readonly List<ImageInfo> _images = [];
    private readonly List<VolumeEntry> _volumes = [];
    private readonly List<NetworkEntry> _networks = [];
    private readonly List<EngineEvent> _history = [];
    private readonly List<Channel<EngineEvent>> _listeners = [];
    private long _lastEventNano;

    public InMemoryDockerEngine(TimeProvider time)
    {
        _time = time;
        Seed();
    }

    /// <summary>Off pretends the engine is stopped: every call is refused as the real one would be.</summary>
    public bool Running { get; set; } = true;

    /// <summary>How often stats readings and new log lines come; the hub tests make it short.</summary>
    public TimeSpan Tick { get; set; } = TimeSpan.FromSeconds(1);

    /// <summary>Every change asked for, in order ("stop shop-web-1"), so a test can prove one never happened.</summary>
    public ConcurrentQueue<string> Changes { get; } = new();

    private long NowMs => _time.GetUtcNow().ToUnixTimeMilliseconds();

    public Task<EngineVersion?> GetVersionAsync(CancellationToken cancellationToken) =>
        Task.FromResult(Running ? new EngineVersion(EngineVersionText, "1.52", "1.44", "1.52", "linux", "amd64") : null);

    public Task<EngineInfo> GetInfoAsync(CancellationToken cancellationToken)
    {
        EnsureRunning();
        return Task.FromResult(new EngineInfo("overlayfs", 2));
    }

    public Task<IReadOnlyList<EngineContainer>> ListContainersAsync(CancellationToken cancellationToken)
    {
        EnsureRunning();
        lock (_gate)
        {
            return Task.FromResult<IReadOnlyList<EngineContainer>>([.. _containers.Select(c => new EngineContainer(c.Summary(NowMs), c.Labels))]);
        }
    }

    public Task<EngineInspection> InspectContainerAsync(string container, CancellationToken cancellationToken)
    {
        EnsureRunning();
        lock (_gate)
        {
            var found = Find(container);
            return Task.FromResult(new EngineInspection(found.Details(NowMs), [.. found.Environment]));
        }
    }

    public Task StartContainerAsync(string container, CancellationToken cancellationToken) =>
        Change("start", container, found =>
        {
            if (found.State is ContainerState.Running or ContainerState.Paused)
            {
                return;
            }

            found.Start(NowMs);
            Raise("container", "start", found);
        });

    public Task StopContainerAsync(string container, int? timeoutSeconds, CancellationToken cancellationToken) =>
        Change("stop", container, found =>
        {
            if (found.State is not (ContainerState.Running or ContainerState.Paused))
            {
                return;
            }

            Raise("container", "kill", found, ("signal", "15"));
            found.Exit(NowMs, 0);
            Raise("container", "die", found, ("exitCode", "0"));
            Raise("container", "stop", found);
        });

    public Task RestartContainerAsync(string container, int? timeoutSeconds, CancellationToken cancellationToken) =>
        Change("restart", container, found =>
        {
            if (found.State is ContainerState.Running or ContainerState.Paused)
            {
                found.Exit(NowMs, 0);
                Raise("container", "die", found, ("exitCode", "0"));
            }

            found.Start(NowMs);
            found.RestartCount++;
            Raise("container", "start", found);
            Raise("container", "restart", found);
        });

    public Task PauseContainerAsync(string container, CancellationToken cancellationToken) =>
        Change("pause", container, found =>
        {
            if (found.State != ContainerState.Running)
            {
                throw new DockerRequestException($"Container {found.Id} is not running");
            }

            found.State = ContainerState.Paused;
            Raise("container", "pause", found);
        });

    public Task UnpauseContainerAsync(string container, CancellationToken cancellationToken) =>
        Change("unpause", container, found =>
        {
            if (found.State != ContainerState.Paused)
            {
                throw new DockerRequestException($"Container {found.Id} is not paused");
            }

            found.State = ContainerState.Running;
            Raise("container", "unpause", found);
        });

    public Task KillContainerAsync(string container, string signal, CancellationToken cancellationToken) =>
        Change($"kill:{signal}", container, found =>
        {
            if (found.State is not (ContainerState.Running or ContainerState.Paused))
            {
                throw new DockerRequestException($"Cannot kill container: {found.Name}: container {found.Id} is not running");
            }

            Raise("container", "kill", found, ("signal", signal));
            if (signal is "SIGKILL" or "SIGTERM" or "SIGINT" or "SIGQUIT")
            {
                found.Exit(NowMs, signal == "SIGKILL" ? 137 : 143);
                Raise("container", "die", found, ("exitCode", found.ExitCode.ToString(System.Globalization.CultureInfo.InvariantCulture)));
            }
        });

    public Task RemoveContainerAsync(string container, bool removeVolumes, bool force, CancellationToken cancellationToken) =>
        Change(removeVolumes ? "remove-with-volumes" : "remove", container, found =>
        {
            if (found.State is ContainerState.Running or ContainerState.Paused && !force)
            {
                throw new DockerRequestException(
                    $"cannot remove container \"{found.Name}\": container is running: stop the container before removing or force remove");
            }

            _containers.Remove(found);
            if (removeVolumes)
            {
                _volumes.RemoveAll(volume => volume.Anonymous && found.Mounts.Any(mount => mount.Name == volume.Name));
            }

            Raise("container", "destroy", found);
        });

    public async IAsyncEnumerable<StatsReading> StreamStatsAsync(string container, [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        EnsureRunning();
        Container found;
        lock (_gate)
        {
            found = Find(container);
        }

        while (true)
        {
            StatsReading? reading;
            lock (_gate)
            {
                reading = found.State == ContainerState.Running && _containers.Contains(found) ? found.Read(_time.GetUtcNow()) : null;
            }

            if (reading is null)
            {
                yield break;
            }

            yield return reading;
            await Task.Delay(Tick, _time, cancellationToken);
        }
    }

    public async IAsyncEnumerable<LogChunk> ReadLogsAsync(string container, LogOptions options, [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(options);
        EnsureRunning();
        Container found;
        List<LogEntry> past;
        lock (_gate)
        {
            found = Find(container);
            found.CatchUp(_time.GetUtcNow());
            var since = options.Since is { } text && long.TryParse(text.Split('.')[0], System.Globalization.CultureInfo.InvariantCulture, out var seconds) ? seconds * 1000 : 0;
            past = [.. found.Log.Where(entry => entry.AtMs >= since)];
            if (options.Tail is int tail)
            {
                past = [.. past.Skip(Math.Max(0, past.Count - tail))];
            }
        }

        foreach (var entry in past)
        {
            yield return found.Chunk(entry);
        }

        var seen = past.Count > 0 ? past[^1].Sequence : found.LastSequence;
        while (options.Follow)
        {
            await Task.Delay(Tick, _time, cancellationToken);
            List<LogEntry> fresh;
            lock (_gate)
            {
                found.CatchUp(_time.GetUtcNow());
                fresh = [.. found.Log.Where(entry => entry.Sequence > seen)];
            }

            foreach (var entry in fresh)
            {
                seen = entry.Sequence;
                yield return found.Chunk(entry);
            }
        }
    }

    public Task<IExecSession> StartExecAsync(string container, ExecOptions options, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(options);
        EnsureRunning();
        lock (_gate)
        {
            var found = Find(container);
            if (found.State != ContainerState.Running)
            {
                throw new DockerRequestException($"container {found.Id} is not running");
            }

            Changes.Enqueue($"exec {found.Name} {string.Join(' ', options.Command)}");
            Raise("container", $"exec_create: {string.Join(' ', options.Command)}", found);
            return Task.FromResult<IExecSession>(new Shell(found.Id[..12], options.User ?? "root"));
        }
    }

    private void EnsureRunning()
    {
        if (!Running)
        {
            throw new DockerUnavailableException("Docker is not running: nothing answers on /var/run/docker.sock.");
        }
    }

    private Task Change(string what, string container, Action<Container> change)
    {
        EnsureRunning();
        lock (_gate)
        {
            var found = Find(container);
            change(found);
            Changes.Enqueue($"{what} {found.Name}");
        }

        return Task.CompletedTask;
    }

    private Container Find(string reference) =>
        _containers.FirstOrDefault(c => c.Name == reference || c.Id == reference || (reference.Length >= 12 && c.Id.StartsWith(reference, StringComparison.Ordinal)))
        ?? throw new DockerNotFoundException($"No such container: {reference}");

    private void Raise(string type, string action, Container container, params (string Name, string Value)[] extra)
    {
        var attributes = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["name"] = container.Name,
            ["image"] = container.Image,
        };
        foreach (var (name, value) in container.Labels)
        {
            attributes[name] = value;
        }

        foreach (var (name, value) in extra)
        {
            attributes[name] = value;
        }

        Raise(new EngineEvent(type, action, container.Id, NextEventNano(), attributes));
    }

    private void Raise(EngineEvent engineEvent)
    {
        _history.Add(engineEvent);
        if (_history.Count > 500)
        {
            _history.RemoveAt(0);
        }

        foreach (var listener in _listeners)
        {
            listener.Writer.TryWrite(engineEvent);
        }
    }

    private long NextEventNano()
    {
        var now = _time.GetUtcNow().ToUnixTimeMilliseconds() * 1_000_000;
        _lastEventNano = Math.Max(now, _lastEventNano + 1);
        return _lastEventNano;
    }

    private static string IdOf(string name) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(name)));

    /// <summary>A shell good enough to try the console with: it echoes, knows a few commands and exits.</summary>
    private sealed class Shell(string hostname, string user) : IExecSession
    {
        private readonly Channel<byte[]> _screen = Channel.CreateUnbounded<byte[]>();
        private readonly StringBuilder _line = new();
        private bool _started;
        private int? _exitCode;

        private string Prompt => $"{user}@{hostname}:/# ";

        public async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken)
        {
            if (!_started)
            {
                _started = true;
                Print(Prompt);
            }

            if (!await _screen.Reader.WaitToReadAsync(cancellationToken) || !_screen.Reader.TryRead(out var chunk))
            {
                return 0;
            }

            var length = Math.Min(chunk.Length, buffer.Length);
            chunk.AsSpan(0, length).CopyTo(buffer.Span);
            return length;
        }

        public ValueTask WriteAsync(ReadOnlyMemory<byte> data, CancellationToken cancellationToken)
        {
            foreach (var character in Encoding.UTF8.GetString(data.Span))
            {
                Type(character);
            }

            return ValueTask.CompletedTask;
        }

        public Task ResizeAsync(int columns, int rows, CancellationToken cancellationToken) => Task.CompletedTask;

        public Task<int?> ExitCodeAsync(CancellationToken cancellationToken) => Task.FromResult(_exitCode);

        public ValueTask DisposeAsync()
        {
            _screen.Writer.TryComplete();
            return ValueTask.CompletedTask;
        }

        private void Type(char character)
        {
            if (_exitCode is not null)
            {
                return;
            }

            switch (character)
            {
                case '\r' or '\n':
                    Print("\r\n");
                    Run(_line.ToString().Trim());
                    _line.Clear();
                    break;
                case '\u007f' or '\b':
                    if (_line.Length > 0)
                    {
                        _line.Length--;
                        Print("\b \b");
                    }

                    break;
                case '\u0003':
                    _line.Clear();
                    Print("^C\r\n" + Prompt);
                    break;
                default:
                    _line.Append(character);
                    Print(character.ToString());
                    break;
            }
        }

        private void Run(string command)
        {
            var output = command switch
            {
                "" => string.Empty,
                "exit" => null,
                "ls" => "bin  boot  dev  etc  home  lib  proc  root  run  srv  sys  tmp  usr  var\r\n",
                "hostname" => hostname + "\r\n",
                "whoami" => user + "\r\n",
                "pwd" => "/\r\n",
                _ when command.StartsWith("echo ", StringComparison.Ordinal) => command[5..] + "\r\n",
                _ => $"sh: 1: {command.Split(' ')[0]}: not found\r\n",
            };
            if (output is null)
            {
                _exitCode = 0;
                Print("exit\r\n");
                _screen.Writer.TryComplete();
                return;
            }

            Print(output + Prompt);
        }

        private void Print(string text) => _screen.Writer.TryWrite(Encoding.UTF8.GetBytes(text));
    }
}
