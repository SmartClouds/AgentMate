using System.Buffers;
using System.Collections.Concurrent;
using System.IO.Pipelines;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Connections;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace Runova.ServerCore.Tests.Docker;

/// <summary>
/// A Docker Engine that replays payloads recorded from Docker 29.8.1 (Fixtures/docker): Kestrel on
/// a Unix socket, with API version negotiation as the daemon does it (a version above its own or
/// below its minimum is refused with the daemon's message). Runs on Linux and on Windows, which has
/// Unix sockets too. Every request is recorded, with the API version taken off its path.
/// </summary>
/// <remarks>
/// Kestrel refuses an upgrade request that carries a body, and docker exec's start is exactly
/// that, so the connection middleware takes those requests off Kestrel and answers them itself:
/// 101, then a pretend shell over the raw connection.
/// </remarks>
internal sealed partial class FakeDockerDaemon : IAsyncDisposable
{
    private const string ShellPrompt = "$ ";

    private readonly WebApplication _app;
    private readonly Dictionary<string, JsonObject> _inspections = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, int> _execExitCodes = new(StringComparer.Ordinal);

    private FakeDockerDaemon(string socketPath, string apiVersion, string minApiVersion)
    {
        SocketPath = socketPath;
        ApiVersion = apiVersion;
        MinApiVersion = minApiVersion;
        foreach (var name in new[] { "shop-api-1", "shop-worker-1", "toolbox", "migrate-once" })
        {
            var inspection = JsonNode.Parse(Read($"inspect-{name}.json"))!.AsObject();
            _inspections[name] = inspection;
            _inspections[inspection["Id"]!.GetValue<string>()] = inspection;
        }

        var stream = Read("stats-v2-stream.ndjson").Split('\n', StringSplitOptions.RemoveEmptyEntries);
        Stats["shop-api-1"] = stream;
        Stats["legacy-v1"] = [Read("stats-v1.json").Trim()];
        Stats["oneshot"] = [Read("stats-v2-oneshot.json").Trim()];

        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.ConfigureKestrel(kestrel =>
            kestrel.ListenUnixSocket(socketPath, listen => listen.Use(next => connection => RouteConnectionAsync(connection, next))));
        _app = builder.Build();
        _app.Run(HandleAsync);
    }

    public string SocketPath { get; }

    public Uri Endpoint => new("unix://" + (SocketPath.StartsWith('/') ? string.Empty : "/") + SocketPath.Replace('\\', '/'));

    public string ApiVersion { get; }

    public string MinApiVersion { get; }

    /// <summary>"METHOD /path?query", the API version taken off the path.</summary>
    public ConcurrentQueue<string> Requests { get; } = new();

    public ConcurrentQueue<string> RequestedVersions { get; } = new();

    /// <summary>Request bodies of exec creations, as JSON.</summary>
    public ConcurrentQueue<string> ExecBodies { get; } = new();

    /// <summary>Lines typed into consoles.</summary>
    public ConcurrentQueue<string> TypedLines { get; } = new();

    /// <summary>Stats payloads per container, streamed in order.</summary>
    public Dictionary<string, string[]> Stats { get; } = new(StringComparer.Ordinal);

    public static string Read(string name) => Fixtures.Read($"docker/{name}");

    public static async Task<FakeDockerDaemon> StartAsync(string apiVersion = "1.56", string minApiVersion = "1.40")
    {
        var path = Path.Combine(Path.GetTempPath(), $"fdd-{Guid.NewGuid():N}"[..14] + ".sock");
        var daemon = new FakeDockerDaemon(path, apiVersion, minApiVersion);
        await daemon._app.StartAsync(TestContext.Current.CancellationToken);
        return daemon;
    }

    public async ValueTask DisposeAsync()
    {
        await _app.StopAsync(CancellationToken.None);
        await _app.DisposeAsync();
        try
        {
            File.Delete(SocketPath);
        }
        catch (IOException)
        {
            // Kestrel removes it on most systems.
        }
    }

    private async Task HandleAsync(HttpContext context)
    {
        var path = context.Request.Path.Value ?? "/";
        var version = VersionPrefix().Match(path);
        if (version.Success)
        {
            var requested = Version.Parse(version.Groups[1].Value);
            if (requested > Version.Parse(ApiVersion))
            {
                await ErrorAsync(context, 400, $"client version {requested} is too new. Maximum supported API version is {ApiVersion}");
                return;
            }

            if (requested < Version.Parse(MinApiVersion))
            {
                await ErrorAsync(context, 400, $"client version {requested} is too old. Minimum supported API version is {MinApiVersion}, please upgrade your client to a newer version");
                return;
            }

            RequestedVersions.Enqueue(version.Groups[1].Value);
            path = path[(version.Length - 1)..];
        }

        var method = context.Request.Method;
        Requests.Enqueue($"{method} {path}{context.Request.QueryString.Value}");
        var segments = path.Trim('/').Split('/');
        var query = context.Request.Query;
        if (await HandleFilesAsync(context, method, segments, query))
        {
            return;
        }

        switch (method, segments)
        {
            case ("GET" or "HEAD", ["_ping"]):
                context.Response.Headers.Append("Api-Version", ApiVersion);
                context.Response.Headers["Ostype"] = "linux";
                await context.Response.WriteAsync(method == "HEAD" ? string.Empty : "OK");
                return;
            case ("GET", ["version"]):
                var versionJson = JsonNode.Parse(Read("version.json"))!.AsObject();
                versionJson[nameof(ApiVersion)] = ApiVersion;
                versionJson["MinAPIVersion"] = MinApiVersion;
                await JsonAsync(context, versionJson.ToJsonString());
                return;
            case ("GET", ["info"]):
                await JsonAsync(context, Read("info.json"));
                return;
            case ("GET", ["containers", "json"]):
                await JsonAsync(context, ListContainers(query["filters"]));
                return;
            case ("GET", ["containers", var id, "json"]):
                if (Find(id) is { } inspection)
                {
                    await JsonAsync(context, inspection.ToJsonString());
                }
                else
                {
                    await ErrorAsync(context, 404, $"No such container: {id}");
                }

                return;
            case ("GET", ["containers", var id, "stats"]):
                await StreamStatsAsync(context, id, query["stream"] != "false" && query["stream"] != "0");
                return;
            case ("GET", ["containers", var id, "logs"]):
                await StreamLogsAsync(context, id, IsTrue(query["follow"]));
                return;
            case ("POST", ["containers", var id, "start" or "stop" or "restart" or "pause" or "unpause" or "kill"]):
                context.Response.StatusCode = Find(id) is null ? 404 : 204;
                return;
            case ("DELETE", ["containers", var id]):
                await RemoveContainerAsync(context, id, IsTrue(query["force"]));
                return;
            case ("GET", ["exec", var inspected, "json"]):
                var code = _execExitCodes.TryGetValue(inspected, out var known) ? known : -1;
                await JsonAsync(context, $$"""{"ID":"{{inspected}}","Running":{{(code < 0 ? "true" : "false")}},"ExitCode":{{Math.Max(code, 0)}}}""");
                return;
            case ("POST", ["exec", _, "resize"]):
                context.Response.StatusCode = 200;
                return;
            case ("GET", ["images", "json"]):
                await JsonAsync(context, Read("images.json"));
                return;
            case ("POST", ["images", "create"]):
                await PullAsync(context, query["fromImage"], query["tag"]);
                return;
            case ("DELETE", ["images", ..]):
                await JsonAsync(context, """[{"Untagged":"busybox:1.37"}]""");
                return;
            case ("GET", ["volumes"]):
                await JsonAsync(context, Read("volumes.json"));
                return;
            case ("DELETE", ["volumes", _]):
                context.Response.StatusCode = 204;
                return;
            case ("GET", ["networks"]):
                await JsonAsync(context, Read("networks.json"));
                return;
            case ("DELETE", ["networks", _]):
                context.Response.StatusCode = 204;
                return;
            case ("GET", ["system", "df"]):
                await JsonAsync(context, Read("system-df.json"));
                return;
            case ("POST", ["containers", "prune"]):
                await JsonAsync(context, """{"ContainersDeleted":["0f1e2d3c4b5a"],"SpaceReclaimed":4096}""");
                return;
            case ("POST", ["images", "prune"]):
                await JsonAsync(context, """{"ImagesDeleted":[{"Untagged":"old:1"},{"Deleted":"sha256:aa"}],"SpaceReclaimed":73400320}""");
                return;
            case ("POST", ["volumes", "prune"]):
                await JsonAsync(context, """{"VolumesDeleted":["a1b2c3"],"SpaceReclaimed":1048576}""");
                return;
            case ("POST", ["networks", "prune"]):
                await JsonAsync(context, """{"NetworksDeleted":["old_default"]}""");
                return;
            case ("GET", ["events"]):
                await StreamEventsAsync(context, query["since"], query["until"]);
                return;
            default:
                await ErrorAsync(context, 404, "page not found");
                return;
        }
    }

    private static bool IsTrue(string? value) => value is "1" or "true" or "True";

    private JsonObject? Find(string id)
    {
        if (_inspections.TryGetValue(id, out var exact))
        {
            return exact;
        }

        return id.Length >= 12 ? _inspections.Values.FirstOrDefault(i => i["Id"]!.GetValue<string>().StartsWith(id, StringComparison.Ordinal)) : null;
    }

    private static string ListContainers(string? filters)
    {
        var all = JsonNode.Parse(Read("containers.json"))!.AsArray();
        if (string.IsNullOrEmpty(filters) || JsonNode.Parse(filters)?["id"] is not JsonObject ids)
        {
            return all.ToJsonString();
        }

        var wanted = ids.Select(id => id.Key).ToHashSet(StringComparer.Ordinal);
        return new JsonArray([.. all.Where(c => wanted.Contains(c!["Id"]!.GetValue<string>())).Select(c => c!.DeepClone())]).ToJsonString();
    }

    private async Task StreamStatsAsync(HttpContext context, string id, bool stream)
    {
        var key = Find(id)?["Name"]?.GetValue<string>().TrimStart('/') ?? id;
        if (!Stats.TryGetValue(key, out var payloads))
        {
            await ErrorAsync(context, 404, $"No such container: {id}");
            return;
        }

        context.Response.ContentType = "application/json";
        foreach (var payload in stream ? payloads : payloads[..1])
        {
            await context.Response.WriteAsync(payload + "\n");
            await context.Response.Body.FlushAsync();
            if (stream)
            {
                await Task.Delay(20);
            }
        }

        if (stream)
        {
            await WaitForCloseAsync(context);
        }
    }

    private async Task StreamLogsAsync(HttpContext context, string id, bool follow)
    {
        var name = Find(id)?["Name"]?.GetValue<string>().TrimStart('/');
        if (name is not ("shop-api-1" or "shop-worker-1"))
        {
            await ErrorAsync(context, 404, $"No such container: {id}");
            return;
        }

        var tty = name == "shop-worker-1";
        context.Response.ContentType = tty ? "application/vnd.docker.raw-stream" : "application/vnd.docker.multiplexed-stream";
        await context.Response.Body.WriteAsync(File.ReadAllBytes(Fixtures.PathOf(tty ? "docker/logs-worker-tty.bin" : "docker/logs-api.bin")));
        await context.Response.Body.FlushAsync();
        if (follow)
        {
            await WaitForCloseAsync(context);
        }
    }

    private async Task RemoveContainerAsync(HttpContext context, string id, bool force)
    {
        var container = Find(id);
        if (container is null)
        {
            await ErrorAsync(context, 404, $"No such container: {id}");
        }
        else if (!force && container["State"]?["Running"]?.GetValue<bool>() == true)
        {
            await ErrorAsync(context, 409, $"cannot remove container \"{id}\": container is running: stop the container before removing or force remove");
        }
        else
        {
            context.Response.StatusCode = 204;
        }
    }

    private static async Task PullAsync(HttpContext context, string? image, string? tag)
    {
        if (image != "busybox" || tag != "1.37")
        {
            await ErrorAsync(context, 404, JsonNode.Parse(Read("pull-missing.ndjson"))!["message"]!.GetValue<string>());
            return;
        }

        context.Response.ContentType = "application/json";
        await context.Response.WriteAsync(Read("pull-busybox.ndjson"));
    }

    private static async Task StreamEventsAsync(HttpContext context, string? since, string? until)
    {
        var after = since is { Length: > 0 } ? Nanoseconds(since) : 0;
        context.Response.ContentType = "application/json";
        foreach (var line in Read("events.ndjson").Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            if (JsonNode.Parse(line)!["timeNano"]!.GetValue<long>() >= after)
            {
                await context.Response.WriteAsync(line + "\n");
            }
        }

        await context.Response.Body.FlushAsync();
        if (string.IsNullOrEmpty(until))
        {
            await WaitForCloseAsync(context);
        }
    }

    private static long Nanoseconds(string engineTime)
    {
        var parts = engineTime.Split('.');
        var seconds = long.Parse(parts[0], System.Globalization.CultureInfo.InvariantCulture);
        var fraction = parts.Length > 1 ? long.Parse(parts[1].PadRight(9, '0')[..9], System.Globalization.CultureInfo.InvariantCulture) : 0;
        return (seconds * 1_000_000_000) + fraction;
    }

    private static async Task WaitForCloseAsync(HttpContext context)
    {
        try
        {
            await Task.Delay(Timeout.Infinite, context.RequestAborted);
        }
        catch (OperationCanceledException)
        {
            // The client went away.
        }
    }

    private static Task JsonAsync(HttpContext context, string json, int status = 200)
    {
        context.Response.StatusCode = status;
        context.Response.ContentType = "application/json";
        return context.Response.WriteAsync(json);
    }

    private static Task ErrorAsync(HttpContext context, int status, string message) =>
        JsonAsync(context, new JsonObject { ["message"] = message }.ToJsonString(), status);

    /// <summary>
    /// Reads a connection's request line before Kestrel does. An exec start is answered here; anything
    /// else goes on to Kestrel with the bytes already read put back in front.
    /// </summary>
    private async Task RouteConnectionAsync(ConnectionContext connection, ConnectionDelegate next)
    {
        var original = connection.Transport;
        var replay = new Pipe();
        string? requestLine = null;
        while (requestLine is null)
        {
            var result = await original.Input.ReadAsync();
            var buffer = result.Buffer;
            if (buffer.PositionOf((byte)'\n') is { } end)
            {
                requestLine = Encoding.ASCII.GetString(buffer.Slice(0, end).ToArray()).TrimEnd('\r');
            }

            foreach (var segment in buffer)
            {
                await replay.Writer.WriteAsync(segment);
            }

            original.Input.AdvanceTo(buffer.End);
            if (result.IsCompleted)
            {
                requestLine ??= string.Empty;
                await replay.Writer.CompleteAsync();
                break;
            }
        }

        if (ExecStart().Match(requestLine) is { Success: true } exec)
        {
            await replay.Writer.CompleteAsync();
            var execId = exec.Groups[1].Value;
            await (IsCommandExec(execId) ? RunCommandAsync(execId, replay.Reader, original) : RunShellAsync(execId, replay.Reader, original));
            return;
        }

        var pump = PumpAsync(original.Input, replay.Writer);
        connection.Transport = new Duplex(replay.Reader, original.Output);
        try
        {
            await next(connection);
        }
        finally
        {
            // Kestrel is done with the request (the client asked to close); so is the copy.
            connection.Transport = original;
            original.Input.CancelPendingRead();
            await pump;
        }
    }

    private static async Task PumpAsync(PipeReader from, PipeWriter to)
    {
        try
        {
            while (true)
            {
                var result = await from.ReadAsync();
                foreach (var segment in result.Buffer)
                {
                    await to.WriteAsync(segment);
                }

                from.AdvanceTo(result.Buffer.End);
                if (result.IsCompleted || result.IsCanceled)
                {
                    break;
                }
            }
        }
        catch (Exception error) when (error is IOException or ObjectDisposedException or InvalidOperationException or ConnectionResetException)
        {
            // The connection went away.
        }
        finally
        {
            await to.CompleteAsync();
        }
    }

    /// <summary>
    /// A shell that echoes what is typed and answers each line with "you typed: ...". "exit" ends
    /// it with code 0 and "fail" with code 3, as the exec's inspection then reports.
    /// </summary>
    private async Task RunShellAsync(string execId, PipeReader replayed, IDuplexPipe connection)
    {
        // The rest of the request (headers and body) may still be on its way.
        var request = new List<byte>();
        await foreach (var chunk in ReadAllAsync(replayed))
        {
            request.AddRange(chunk);
        }

        var input = connection.Input;
        while (!HasWholeRequest(request))
        {
            var more = await input.ReadAsync();
            request.AddRange(more.Buffer.ToArray());
            input.AdvanceTo(more.Buffer.End);
            if (more.IsCompleted)
            {
                return;
            }
        }

        var output = connection.Output;
        await output.WriteAsync(Encoding.ASCII.GetBytes(
            "HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n" + ShellPrompt));
        var line = new StringBuilder();
        var leftover = request.Skip(RequestLength(request)).ToArray();
        var pending = new Queue<byte>(leftover);
        while (true)
        {
            if (pending.Count == 0)
            {
                var read = await input.ReadAsync();
                foreach (var b in read.Buffer.ToArray())
                {
                    pending.Enqueue(b);
                }

                input.AdvanceTo(read.Buffer.End);
                if (read.IsCompleted && pending.Count == 0)
                {
                    _execExitCodes[execId] = 0;
                    break;
                }
            }

            var character = (char)pending.Dequeue();
            if (character != '\r')
            {
                line.Append(character);
                await output.WriteAsync(new[] { (byte)character });
                continue;
            }

            var typed = line.ToString();
            line.Clear();
            TypedLines.Enqueue(typed);
            if (typed is "exit" or "fail")
            {
                _execExitCodes[execId] = typed == "exit" ? 0 : 3;
                await output.WriteAsync(Encoding.ASCII.GetBytes("\r\n"));
                break;
            }

            await output.WriteAsync(Encoding.UTF8.GetBytes($"\r\nyou typed: {typed}\r\n{ShellPrompt}"));
        }

        await output.CompleteAsync();
        await input.CompleteAsync();
    }

    private static async IAsyncEnumerable<byte[]> ReadAllAsync(PipeReader reader)
    {
        while (true)
        {
            var result = await reader.ReadAsync();
            yield return result.Buffer.ToArray();
            reader.AdvanceTo(result.Buffer.End);
            if (result.IsCompleted)
            {
                yield break;
            }
        }
    }

    private static bool HasWholeRequest(List<byte> request) => RequestLength(request) <= request.Count && RequestLength(request) > 0;

    /// <summary>Headers plus Content-Length, or 0 while the headers are incomplete.</summary>
    private static int RequestLength(List<byte> request)
    {
        var text = Encoding.ASCII.GetString([.. request]);
        var headersEnd = text.IndexOf("\r\n\r\n", StringComparison.Ordinal);
        if (headersEnd < 0)
        {
            return 0;
        }

        var length = ContentLength().Match(text[..headersEnd]);
        return headersEnd + 4 + (length.Success ? int.Parse(length.Groups[1].Value, System.Globalization.CultureInfo.InvariantCulture) : 0);
    }

    [GeneratedRegex(@"^/v(\d+\.\d+)/", RegexOptions.CultureInvariant)]
    private static partial Regex VersionPrefix();

    [GeneratedRegex(@"^POST /(?:v\d+\.\d+/)?exec/([0-9a-f]+)/start ", RegexOptions.CultureInvariant)]
    private static partial Regex ExecStart();

    [GeneratedRegex(@"(?im)^content-length:\s*(\d+)\s*$", RegexOptions.CultureInvariant)]
    private static partial Regex ContentLength();

    private sealed class Duplex(PipeReader input, PipeWriter output) : IDuplexPipe
    {
        public PipeReader Input { get; } = input;

        public PipeWriter Output { get; } = output;
    }
}
