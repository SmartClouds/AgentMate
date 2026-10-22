using System.Runtime.ExceptionServices;
using Docker.DotNet;
using Docker.DotNet.Models;

namespace AgentMate.ServerCore.Docker;

/// <summary>
/// What the file manager (E27) needs from the engine: execs without a TTY, the archive API and
/// helper containers. Transfers go through the client without a request timeout; a stalled one is
/// ended by its caller's token (the request going away, or the core's own deadline).
/// </summary>
internal sealed partial class DockerEngine
{
    /// <summary>Stderr is for error messages; more than this is not worth reading.</summary>
    private const int MaxStderrBytes = 64 * 1024;

    private static readonly TimeSpan _exitWait = TimeSpan.FromMilliseconds(50);

    public Task<ExecResult> RunExecAsync(string container, IReadOnlyList<string> command, string? user, TimeSpan timeout, int outputCapBytes, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        return CallAsync(
            async client =>
            {
                using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                deadline.CancelAfter(timeout);
                try
                {
                    var created = await client.Exec.CreateContainerExecAsync(
                        container,
                        new ContainerExecCreateParameters
                        {
                            AttachStdin = false,
                            AttachStdout = true,
                            AttachStderr = true,
                            TTY = false,
                            Cmd = [.. command],
                            User = user ?? string.Empty,
                        },
                        deadline.Token);
                    using var stream = await client.Exec.StartContainerExecAsync(created.ID, new ContainerExecStartParameters { TTY = false }, deadline.Token);
                    using var closeOnDeadline = deadline.Token.Register(stream.Dispose);
                    var (stdout, stderr, truncated) = await ReadExecOutputAsync(stream, outputCapBytes, deadline.Token);
                    var exitCode = truncated ? null : await ExecExitCodeAsync(client, created.ID, deadline.Token);
                    return new ExecResult(exitCode, stdout, stderr, truncated);
                }
                catch (Exception error) when (deadline.IsCancellationRequested && !cancellationToken.IsCancellationRequested
                    && error is OperationCanceledException or IOException or ObjectDisposedException)
                {
                    throw new DockerRequestException($"The command in the container did not finish within {timeout.TotalSeconds:0} seconds.");
                }
            },
            cancellationToken);
    }

    public async Task<PathStat?> StatPathAsync(string container, string path, CancellationToken cancellationToken)
    {
        try
        {
            return await CallAsync(
                async client =>
                {
                    var response = await client.Containers.GetArchiveFromContainerAsync(container, new ContainerPathStatParameters { Path = path }, statOnly: true, cancellationToken);
                    var stat = response.Stat;
                    return new PathStat(
                        stat.Name ?? string.Empty,
                        stat.Size,
                        DockerMapping.PosixMode(stat.Mode),
                        new DateTimeOffset(DateTime.SpecifyKind(stat.Mtime.ToUniversalTime(), DateTimeKind.Utc)).ToUnixTimeMilliseconds(),
                        string.IsNullOrEmpty(stat.LinkTarget) ? null : stat.LinkTarget);
                },
                cancellationToken);
        }
        catch (DockerNotFoundException)
        {
            // A HEAD answer has no body to say which of the two was missing.
            await CallAsync(client => client.Containers.InspectContainerAsync(container, cancellationToken), cancellationToken);
            return null;
        }
    }

    public async Task<Stream> GetArchiveAsync(string container, string path, CancellationToken cancellationToken)
    {
        try
        {
            return await TransferAsync(
                async client => (await client.Containers.GetArchiveFromContainerAsync(container, new ContainerPathStatParameters { Path = path }, statOnly: false, cancellationToken)).Stream
                    ?? throw new DockerRequestException("Docker answered without an archive."),
                cancellationToken);
        }
        catch (DockerNotFoundException missing) when (IsMissingPath(missing))
        {
            throw new DockerPathNotFoundException(missing.Message);
        }
    }

    /// <summary>
    /// A body that fails part of the way (an upload cut short, a client gone) surfaces from the
    /// HTTP client as a broken connection. Its own error is what happened, so that is what is
    /// thrown, and the engine connection is kept rather than dropped as unreachable.
    /// </summary>
    public async Task PutArchiveAsync(string container, string folder, Stream archive, CancellationToken cancellationToken)
    {
        var source = new GuardedSource(archive);
        var client = await ClientAsync(cancellationToken);
        try
        {
            await (Volatile.Read(ref _transfers) ?? client).Containers.ExtractArchiveToContainerAsync(
                container,
                new CopyToContainerParameters { Path = folder },
                source,
                cancellationToken);
        }
        catch (Exception) when (source.Failure is { } failure)
        {
            ExceptionDispatchInfo.Throw(failure);
            throw;
        }
        catch (Exception error) when (Translate(error, cancellationToken) is var translated && !ReferenceEquals(translated, error))
        {
            throw translated is DockerNotFoundException missing && IsMissingPath(missing) ? new DockerPathNotFoundException(missing.Message) : translated;
        }
    }

    public async Task<string> CreateHelperAsync(HelperSpec spec, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(spec);
        string id;
        try
        {
            id = await CreateHelperContainerAsync(spec, cancellationToken);
        }
        catch (DockerNotFoundException missing) when (missing.Message.StartsWith("No such image", StringComparison.Ordinal))
        {
            try
            {
                await PullImageAsync(spec.Image, _ => { }, cancellationToken);
            }
            catch (Exception error) when (error is DockerRequestException or DockerNotFoundException)
            {
                throw new DockerRequestException($"Docker could not download {spec.Image}: {error.Message}");
            }

            id = await CreateHelperContainerAsync(spec, cancellationToken);
        }

        try
        {
            await StartContainerAsync(id, cancellationToken);
        }
        catch
        {
            await RemoveHelperAsync(id, CancellationToken.None);
            throw;
        }

        return id;
    }

    public async Task RemoveHelperAsync(string helper, CancellationToken cancellationToken)
    {
        try
        {
            await RemoveContainerAsync(helper, removeVolumes: false, force: true, cancellationToken);
        }
        catch (DockerNotFoundException)
        {
            // Already gone, which is what was wanted.
        }
    }

    public Task<IReadOnlyList<string>> ListLabelledContainersAsync(string label, CancellationToken cancellationToken) =>
        CallAsync<IReadOnlyList<string>>(
            async client =>
            {
                var listed = await client.Containers.ListContainersAsync(
                    new ContainersListParameters
                    {
                        All = true,
                        Filters = new Dictionary<string, IDictionary<string, bool>> { ["label"] = new Dictionary<string, bool> { [label] = true } },
                    },
                    cancellationToken);
                return [.. listed.Select(container => container.ID)];
            },
            cancellationToken);

    /// <summary>Remembers the first error the wrapped stream threw while it was read.</summary>
    private sealed class GuardedSource(Stream inner) : Stream
    {
        public Exception? Failure { get; private set; }

        public override bool CanRead => true;

        public override bool CanSeek => false;

        public override bool CanWrite => false;

        public override long Length => throw new NotSupportedException();

        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            try
            {
                return inner.Read(buffer, offset, count);
            }
            catch (Exception error)
            {
                Failure ??= error;
                throw;
            }
        }

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            try
            {
                return await inner.ReadAsync(buffer, cancellationToken);
            }
            catch (Exception error)
            {
                Failure ??= error;
                throw;
            }
        }

        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
            ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();

        public override void Flush()
        {
        }

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    private static bool IsMissingPath(DockerNotFoundException error) =>
        error.Message.StartsWith("Could not find the file", StringComparison.Ordinal);

    private Task<string> CreateHelperContainerAsync(HelperSpec spec, CancellationToken cancellationToken) =>
        CallAsync(
            async client =>
            {
                var created = await client.Containers.CreateContainerAsync(
                    new CreateContainerParameters
                    {
                        Name = $"agentmate-files-{Guid.NewGuid():N}"[..28],
                        Image = spec.Image.ToString(),
                        Cmd = [.. spec.Command],
                        Labels = new Dictionary<string, string>(spec.Labels, StringComparer.Ordinal),
                        User = "0:0",
                        HostConfig = new HostConfig
                        {
                            NetworkMode = "none",
                            Mounts = [new Mount { Type = "volume", Source = spec.Volume, Target = spec.MountPoint }],
                            // Root, to read and change any file in the volume, and nothing more.
                            CapDrop = ["ALL"],
                            CapAdd = ["CHOWN", "DAC_OVERRIDE", "DAC_READ_SEARCH", "FOWNER", "FSETID"],
                            SecurityOpt = ["no-new-privileges"],
                            PidsLimit = 64,
                            RestartPolicy = new RestartPolicy { Name = RestartPolicyKind.No },
                        },
                    },
                    cancellationToken);
                return created.ID;
            },
            cancellationToken);

    private async Task<T> TransferAsync<T>(Func<DockerClient, Task<T>> call, CancellationToken cancellationToken)
    {
        await ClientAsync(cancellationToken);
        return await CallAsync(client => call(Volatile.Read(ref _transfers) ?? client), cancellationToken);
    }

    private static async Task<(byte[] Stdout, byte[] Stderr, bool Truncated)> ReadExecOutputAsync(MultiplexedStream stream, int cap, CancellationToken cancellationToken)
    {
        using var stdout = new MemoryStream();
        using var stderr = new MemoryStream();
        var buffer = new byte[64 * 1024];
        while (true)
        {
            var read = await stream.ReadOutputAsync(buffer, 0, buffer.Length, cancellationToken);
            if (read.EOF)
            {
                return (stdout.ToArray(), stderr.ToArray(), false);
            }

            var error = read.Target == MultiplexedStream.TargetStream.StandardError;
            var target = error ? stderr : stdout;
            var room = (error ? Math.Min(cap, MaxStderrBytes) : cap) - (int)target.Length;
            if (read.Count > room)
            {
                target.Write(buffer, 0, Math.Max(room, 0));
                return (stdout.ToArray(), stderr.ToArray(), true);
            }

            target.Write(buffer, 0, read.Count);
        }
    }

    private static async Task<int?> ExecExitCodeAsync(DockerClient client, string execId, CancellationToken cancellationToken)
    {
        // The engine records the exit a moment after the output ends.
        for (var attempt = 0; attempt < 100; attempt++)
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
}
