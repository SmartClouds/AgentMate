using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading.Channels;
using Docker.DotNet;
using Docker.DotNet.Models;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Files;
using Version = System.Version;

namespace Runova.ServerCore.Docker;

/// <summary>
/// The real engine through Docker.DotNet over its Unix socket. The client does not negotiate the
/// API version itself, so this does it the way the docker CLI does: ask the engine for its
/// version without one, then speak the lower of the engine's and <see cref="MaxApiVersion"/>, and
/// refuse an engine older than <see cref="MinApiVersion"/>. A connection failure drops the client,
/// so a restarted or upgraded engine is negotiated with again.
/// </summary>
internal sealed partial class DockerEngine(Uri endpoint, ILogger<DockerEngine> logger) : IDockerEngine, IDisposable
{
    public const string DefaultEndpoint = "unix:///var/run/docker.sock";

    /// <summary>Docker 29.0's API, the one these models were written for.</summary>
    public static readonly Version MaxApiVersion = new(1, 52);

    /// <summary>Docker 25.0. Older engines are past their support and lack what compose needs.</summary>
    public static readonly Version MinApiVersion = new(1, 44);

    private static readonly TimeSpan _requestTimeout = TimeSpan.FromMinutes(5);

    private readonly SemaphoreSlim _gate = new(1, 1);
    private DockerClient? _client;

    /// <summary>
    /// The same engine without the request timeout, for archive transfers (E27): a gigabyte into a
    /// volume over a slow link takes longer than any timeout that suits the other calls.
    /// </summary>
    private DockerClient? _transfers;
    private EngineVersion? _version;

    public async Task<EngineVersion?> GetVersionAsync(CancellationToken cancellationToken)
    {
        try
        {
            await ClientAsync(cancellationToken);
            return _version;
        }
        catch (DockerUnavailableException) when (_version is null && !_tooOld)
        {
            return null;
        }
    }

    public Task<EngineInfo> GetInfoAsync(CancellationToken cancellationToken) =>
        CallAsync(
            async client =>
            {
                var info = await client.System.GetSystemInfoAsync(cancellationToken);
                return new EngineInfo(
                    string.IsNullOrEmpty(info.Driver) ? null : info.Driver,
                    int.TryParse(info.CgroupVersion, NumberStyles.Integer, CultureInfo.InvariantCulture, out var cgroup) ? cgroup : null);
            },
            cancellationToken);

    public Task<IReadOnlyList<EngineContainer>> ListContainersAsync(CancellationToken cancellationToken) =>
        CallAsync<IReadOnlyList<EngineContainer>>(
            async client =>
            {
                var containers = await client.Containers.ListContainersAsync(new ContainersListParameters { All = true }, cancellationToken);

                // The helpers volumes are browsed through are the core's own, not the user's.
                return [.. containers.Select(DockerMapping.Container).Where(c => !VolumeHelpers.Labels.Any(c.Labels.ContainsKey))];
            },
            cancellationToken);

    public Task<EngineInspection> InspectContainerAsync(string container, CancellationToken cancellationToken) =>
        CallAsync(
            async client =>
            {
                var inspected = await client.Containers.InspectContainerAsync(container, cancellationToken);
                var listed = await client.Containers.ListContainersAsync(
                    new ContainersListParameters
                    {
                        All = true,
                        Filters = new Dictionary<string, IDictionary<string, bool>> { ["id"] = new Dictionary<string, bool> { [inspected.ID] = true } },
                    },
                    cancellationToken);
                var summary = listed.FirstOrDefault(c => c.ID == inspected.ID) is { } entry ? DockerMapping.Container(entry).Summary : null;
                return DockerMapping.Inspection(inspected, summary);
            },
            cancellationToken);

    public Task StartContainerAsync(string container, CancellationToken cancellationToken) =>
        CallAsync(client => client.Containers.StartContainerAsync(container, new ContainerStartParameters(), cancellationToken), cancellationToken);

    public Task StopContainerAsync(string container, int? timeoutSeconds, CancellationToken cancellationToken) =>
        CallAsync(
            client => client.Containers.StopContainerAsync(
                container,
                new ContainerStopParameters { WaitBeforeKillSeconds = (uint?)timeoutSeconds },
                cancellationToken),
            cancellationToken);

    public Task RestartContainerAsync(string container, int? timeoutSeconds, CancellationToken cancellationToken) =>
        CallAsync(
            async client =>
            {
                await client.Containers.RestartContainerAsync(
                    container,
                    new ContainerRestartParameters { WaitBeforeKillSeconds = (uint?)timeoutSeconds },
                    cancellationToken);
                return true;
            },
            cancellationToken);

    public Task PauseContainerAsync(string container, CancellationToken cancellationToken) =>
        CallAsync(async client => { await client.Containers.PauseContainerAsync(container, cancellationToken); return true; }, cancellationToken);

    public Task UnpauseContainerAsync(string container, CancellationToken cancellationToken) =>
        CallAsync(async client => { await client.Containers.UnpauseContainerAsync(container, cancellationToken); return true; }, cancellationToken);

    public Task KillContainerAsync(string container, string signal, CancellationToken cancellationToken) =>
        CallAsync(
            async client =>
            {
                await client.Containers.KillContainerAsync(container, new ContainerKillParameters { Signal = signal }, cancellationToken);
                return true;
            },
            cancellationToken);

    public Task RemoveContainerAsync(string container, bool removeVolumes, bool force, CancellationToken cancellationToken) =>
        CallAsync(
            async client =>
            {
                await client.Containers.RemoveContainerAsync(
                    container,
                    new ContainerRemoveParameters { RemoveVolumes = removeVolumes, Force = force },
                    cancellationToken);
                return true;
            },
            cancellationToken);

    public IAsyncEnumerable<StatsReading> StreamStatsAsync(string container, CancellationToken cancellationToken) =>
        StreamAsync<ContainerStatsResponse, StatsReading>(
            (client, progress, token) => client.Containers.GetContainerStatsAsync(container, new ContainerStatsParameters { Stream = true }, progress, token),
            DockerMapping.Reading,
            new BoundedChannelOptions(4) { FullMode = BoundedChannelFullMode.DropOldest, SingleReader = true },
            cancellationToken);

    public async IAsyncEnumerable<LogChunk> ReadLogsAsync(
        string container,
        LogOptions options,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(options);
        var stream = await CallAsync(
            client => client.Containers.GetContainerLogsAsync(
                container,
                new ContainerLogsParameters
                {
                    ShowStdout = true,
                    ShowStderr = true,
                    Timestamps = true,
                    Follow = options.Follow,
                    Tail = options.Tail?.ToString(CultureInfo.InvariantCulture) ?? "all",
                    Since = options.Since,
                },
                cancellationToken),
            cancellationToken);
        using (stream)
        {
            var buffer = new byte[16 * 1024];
            while (true)
            {
                var read = await ReadOutputAsync(stream, buffer, cancellationToken);
                if (read.EOF)
                {
                    yield break;
                }

                yield return new LogChunk(
                    read.Target == MultiplexedStream.TargetStream.StandardError ? ContainerLogSource.Stderr : ContainerLogSource.Stdout,
                    buffer.AsSpan(0, read.Count).ToArray());
            }
        }
    }

    public Task<IExecSession> StartExecAsync(string container, ExecOptions options, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(options);
        var size = new ConsoleSize { Height = (ulong)options.Rows, Width = (ulong)options.Columns };
        return CallAsync<IExecSession>(
            async client =>
            {
                var created = await client.Exec.CreateContainerExecAsync(
                    container,
                    new ContainerExecCreateParameters
                    {
                        AttachStdin = true,
                        AttachStdout = true,
                        AttachStderr = true,
                        TTY = true,
                        Cmd = [.. options.Command],
                        User = options.User ?? string.Empty,
                        Env = ["TERM=xterm-256color"],
                        ConsoleSize = size,
                    },
                    cancellationToken);
                var stream = await client.Exec.StartContainerExecAsync(
                    created.ID,
                    new ContainerExecStartParameters { TTY = true, ConsoleSize = size },
                    cancellationToken);
                return new ExecSession(client, created.ID, stream);
            },
            cancellationToken);
    }

    public void Dispose()
    {
        _client?.Dispose();
        _transfers?.Dispose();
        _gate.Dispose();
    }

    private bool _tooOld;

    private async Task<DockerClient> ClientAsync(CancellationToken cancellationToken)
    {
        if (Volatile.Read(ref _client) is { } ready)
        {
            return ready;
        }

        await _gate.WaitAsync(cancellationToken);
        try
        {
            if (_client is not null)
            {
                return _client;
            }

            VersionResponse version;
            using (var probe = Build(null))
            {
                try
                {
                    version = await probe.System.GetVersionAsync(cancellationToken);
                }
                catch (Exception error) when (IsUnreachable(error))
                {
                    throw Unreachable(error);
                }
            }

            if (!Version.TryParse(version.APIVersion, out var engineApi) || engineApi < MinApiVersion)
            {
                _tooOld = true;
                throw new DockerUnavailableException(
                    $"Docker {version.Version} speaks API {version.APIVersion}; the core needs {MinApiVersion} or later (Docker 25 or later). Upgrade Docker first.");
            }

            _tooOld = false;
            var negotiated = engineApi < MaxApiVersion ? engineApi : MaxApiVersion;
            var spoken = negotiated.ToString();
            _version = new EngineVersion(version.Version ?? string.Empty, version.APIVersion, version.MinAPIVersion ?? string.Empty, spoken, version.Os ?? "linux", version.Arch ?? string.Empty);
            LogNegotiated(logger, _version.Version, version.APIVersion, spoken);
            _transfers = Build(negotiated, Timeout.InfiniteTimeSpan);
            _client = Build(negotiated);
            return _client;
        }
        finally
        {
            _gate.Release();
        }
    }

    private DockerClient Build(Version? apiVersion, TimeSpan? timeout = null) =>
        new DockerClientBuilder()
            .WithEndpoint(endpoint)
            .WithApiVersion(apiVersion)
            .WithTimeout(timeout ?? _requestTimeout)
            .WithTransportOptions(UnixSocketTransport.Instance, endpoint.LocalPath)
            .Build();

    private Task<bool> CallAsync(Func<DockerClient, Task> call, CancellationToken cancellationToken) =>
        CallAsync(
            async client =>
            {
                await call(client);
                return true;
            },
            cancellationToken);

    private async Task<T> CallAsync<T>(Func<DockerClient, Task<T>> call, CancellationToken cancellationToken)
    {
        var client = await ClientAsync(cancellationToken);
        try
        {
            return await call(client);
        }
        catch (Exception error) when (Translate(error, cancellationToken) is var translated && !ReferenceEquals(translated, error))
        {
            throw translated;
        }
    }

    /// <summary>
    /// Runs a call that reports messages through IProgress and hands them out as a sequence. A
    /// bounded channel keeps a slow reader from holding the engine's stream open without limit.
    /// </summary>
    private async IAsyncEnumerable<TOut> StreamAsync<TMessage, TOut>(
        Func<DockerClient, IProgress<TMessage>, CancellationToken, Task> start,
        Func<TMessage, TOut?> map,
        BoundedChannelOptions options,
        [EnumeratorCancellation] CancellationToken cancellationToken)
        where TOut : class
    {
        var client = await ClientAsync(cancellationToken);
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var channel = Channel.CreateBounded<TOut>(options);
        var reporter = new Reporter<TMessage>(message =>
        {
            if (map(message) is { } mapped && !channel.Writer.TryWrite(mapped))
            {
                channel.Writer.TryComplete(new DockerRequestException("The stream fell behind the engine; open it again."));
            }
        });
        var running = Task.Run(
            async () =>
            {
                try
                {
                    await start(client, reporter, stop.Token);
                    channel.Writer.TryComplete();
                }
                catch (Exception error)
                {
                    channel.Writer.TryComplete(stop.IsCancellationRequested ? null : Translate(error, stop.Token));
                }
            },
            CancellationToken.None);
        try
        {
            await foreach (var item in channel.Reader.ReadAllAsync(cancellationToken))
            {
                yield return item;
            }
        }
        finally
        {
            await stop.CancelAsync();
            await running;
        }
    }

    private async Task<MultiplexedStream.ReadResult> ReadOutputAsync(MultiplexedStream stream, byte[] buffer, CancellationToken cancellationToken)
    {
        try
        {
            return await stream.ReadOutputAsync(buffer, 0, buffer.Length, cancellationToken);
        }
        catch (Exception error) when (error is IOException or ObjectDisposedException && cancellationToken.IsCancellationRequested)
        {
            throw new OperationCanceledException(cancellationToken);
        }
        catch (Exception error) when (Translate(error, cancellationToken) is var translated && !ReferenceEquals(translated, error))
        {
            throw translated;
        }
    }

    /// <summary>The engine's own words for a refusal; a lost connection makes the next call negotiate again.</summary>
    private Exception Translate(Exception error, CancellationToken cancellationToken)
    {
        if (error is OperationCanceledException && cancellationToken.IsCancellationRequested)
        {
            return error;
        }

        if (error is DockerApiException api)
        {
            var message = EngineMessage(api);
            return api.StatusCode == HttpStatusCode.NotFound ? new DockerNotFoundException(message) : new DockerRequestException(message);
        }

        if (IsUnreachable(error))
        {
            Reset();
            return Unreachable(error);
        }

        return error;
    }

    private void Reset()
    {
        var client = Interlocked.Exchange(ref _client, null);
        client?.Dispose();
        Interlocked.Exchange(ref _transfers, null)?.Dispose();
        _version = null;
    }

    private DockerUnavailableException Unreachable(Exception error)
    {
        LogUnreachable(logger, endpoint, error);
        return new DockerUnavailableException($"Docker is not running: nothing answers on {endpoint.LocalPath}.", error);
    }

    private static bool IsUnreachable(Exception error) =>
        error is SocketException or HttpRequestException or IOException or TimeoutException
        || (error is OperationCanceledException && error.InnerException is TimeoutException)
        || (error.InnerException is { } inner && inner is not DockerApiException && IsUnreachable(inner));

    private static string EngineMessage(DockerApiException error)
    {
        try
        {
            if (!string.IsNullOrWhiteSpace(error.ResponseBody))
            {
                using var body = JsonDocument.Parse(error.ResponseBody);
                if (body.RootElement.ValueKind == JsonValueKind.Object
                    && body.RootElement.TryGetProperty("message", out var message)
                    && message.GetString() is { Length: > 0 } text)
                {
                    return text;
                }
            }
        }
        catch (JsonException)
        {
            // Not JSON; the status says enough.
        }

        return $"Docker refused the request ({(int)error.StatusCode}).";
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "Docker {Version} speaks API {EngineApi}; the core uses {Negotiated}.")]
    private static partial void LogNegotiated(ILogger logger, string version, string engineApi, string negotiated);

    [LoggerMessage(Level = LogLevel.Debug, Message = "Docker does not answer on {Endpoint}.")]
    private static partial void LogUnreachable(ILogger logger, Uri endpoint, Exception error);

    private sealed class Reporter<T>(Action<T> report) : IProgress<T>
    {
        public void Report(T value) => report(value);
    }

    /// <summary>docker exec with a TTY: one raw stream both ways, resized and inspected by its exec id.</summary>
    private sealed class ExecSession(DockerClient client, string execId, MultiplexedStream stream) : IExecSession
    {
        private static readonly TimeSpan _exitWait = TimeSpan.FromMilliseconds(100);

        public async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken)
        {
            if (!MemoryMarshal.TryGetArray<byte>(buffer, out var array))
            {
                throw new ArgumentException("The console reads into array-backed memory.", nameof(buffer));
            }

            try
            {
                var read = await stream.ReadOutputAsync(array.Array!, array.Offset, array.Count, cancellationToken);
                return read.Count;
            }
            catch (Exception error) when (error is IOException or ObjectDisposedException && !cancellationToken.IsCancellationRequested)
            {
                return 0;
            }
        }

        public async ValueTask WriteAsync(ReadOnlyMemory<byte> data, CancellationToken cancellationToken)
        {
            var copy = data.ToArray();
            await stream.WriteAsync(copy, 0, copy.Length, cancellationToken);
        }

        public Task ResizeAsync(int columns, int rows, CancellationToken cancellationToken) =>
            client.Exec.ResizeExecTtyAsync(execId, new ContainerResizeParameters { Height = rows, Width = columns }, cancellationToken);

        public async Task<int?> ExitCodeAsync(CancellationToken cancellationToken)
        {
            // The engine records the exit a moment after the stream closes.
            for (var attempt = 0; attempt < 20; attempt++)
            {
                var inspected = await client.Exec.InspectContainerExecAsync(execId, cancellationToken);
                if (!inspected.Running)
                {
                    return inspected.ExitCode is long code ? (int)code : null;
                }

                await Task.Delay(_exitWait, cancellationToken);
            }

            return null;
        }

        public ValueTask DisposeAsync()
        {
            stream.Dispose();
            return ValueTask.CompletedTask;
        }
    }
}
