using System.Buffers;
using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.IO.Pipelines;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http;

namespace AgentMate.ServerCore.Tests.Docker;

/// <summary>What a command run without a TTY prints and how it ends.</summary>
internal sealed record FakeExecReply(byte[] Stdout, byte[] Stderr, int ExitCode)
{
    public static FakeExecReply Out(string stdout, int exitCode = 0) => new(Encoding.UTF8.GetBytes(stdout), [], exitCode);
}

/// <summary>
/// The parts of the engine the file manager (E27) uses, answered the way Docker 29.9.1 answered
/// them when they were recorded: execs without a TTY (output framed per stream, as the engine
/// multiplexes it), the archive API (HEAD with the base64 stat header, GET and PUT), and helper
/// containers created, started and removed, pulled by digest first when the image is missing.
/// </summary>
internal sealed partial class FakeDockerDaemon
{
    public const string RecordedOciNoShell = "OCI runtime exec failed: exec failed: unable to start container process: exec: \"sh\": executable file not found in $PATH";

    private readonly ConcurrentDictionary<string, (string Container, bool Tty, string[] Command)> _execs = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, bool> _helpers = new(StringComparer.Ordinal);

    /// <summary>What a command run without a TTY answers; by default it prints its argv joined by spaces.</summary>
    public Func<string, IReadOnlyList<string>, FakeExecReply> ExecReplies { get; set; } =
        (_, command) => FakeExecReply.Out(string.Join(' ', command));

    /// <summary>Paths the archive API knows, by "container:path": the stat JSON and the tar GET answers with.</summary>
    public ConcurrentDictionary<string, (string StatJson, byte[] Tar)> ArchivePaths { get; } = new(StringComparer.Ordinal);

    /// <summary>Archives PUT, with the container and the folder they went to.</summary>
    public ConcurrentQueue<(string Container, string Path, byte[] Tar)> PutArchives { get; } = new();

    /// <summary>A refusal every PUT gets, such as the engine's 400 for a file where a folder should be.</summary>
    public (int Status, string Message)? PutRefusal { get; set; }

    /// <summary>Whether the pinned helper image is there; a pull by digest puts it there.</summary>
    public bool HelperImagePresent { get; set; } = true;

    /// <summary>When set, a pull by digest fails with this message (the engine's 500 for a registry it cannot reach).</summary>
    public string? PullError { get; set; }

    /// <summary>Bodies of container creations, as JSON.</summary>
    public ConcurrentQueue<string> CreatedBodies { get; } = new();

    /// <summary>Helper containers by id, true once started.</summary>
    public IReadOnlyDictionary<string, bool> Helpers => _helpers;

    public static string Stat(string name, long size, uint goMode, string mtime, string linkTarget = "") =>
        new JsonObject { ["name"] = name, ["size"] = size, ["mode"] = goMode, ["mtime"] = mtime, ["linkTarget"] = linkTarget }.ToJsonString();

    private bool IsCommandExec(string execId) => _execs.TryGetValue(execId, out var exec) && !exec.Tty;

    private bool IsRunning(string id) =>
        _helpers.TryGetValue(id, out var started) ? started : Find(id)?["State"]?["Running"]?.GetValue<bool>() == true;

    private bool Exists(string id) => _helpers.ContainsKey(id) || Find(id) is not null;

    /// <summary>The requests this file answers; false sends the request on to the main routes.</summary>
    private async Task<bool> HandleFilesAsync(HttpContext context, string method, string[] segments, IQueryCollection query)
    {
        switch (method, segments)
        {
            case ("POST", ["containers", var id, "exec"]):
                await CreateExecAsync(context, id);
                return true;
            case ("HEAD" or "GET" or "PUT", ["containers", var id, "archive"]):
                await ArchiveAsync(context, method, id, query["path"].ToString());
                return true;
            case ("GET", ["containers", "json"]) when query["filters"].ToString().Contains("\"label\"", StringComparison.Ordinal):
                await JsonAsync(context, new JsonArray([.. HelperSummaries()]).ToJsonString());
                return true;
            case ("GET", ["containers", "json"]) when !_helpers.IsEmpty && string.IsNullOrEmpty(query["filters"].ToString()):
                // The engine lists helpers with every other container.
                var listed = JsonNode.Parse(ListContainers(null))!.AsArray();
                foreach (var helper in HelperSummaries())
                {
                    listed.Add(helper);
                }

                await JsonAsync(context, listed.ToJsonString());
                return true;
            case ("POST", ["containers", "create"]):
                await CreateHelperAsync(context);
                return true;
            case ("POST", ["containers", var id, "start"]) when _helpers.ContainsKey(id):
                _helpers[id] = true;
                context.Response.StatusCode = 204;
                return true;
            case ("DELETE", ["containers", var id]) when _helpers.ContainsKey(id):
                _helpers.TryRemove(id, out _);
                context.Response.StatusCode = 204;
                return true;
            case ("POST", ["images", "create"]) when query["fromImage"].ToString().Contains("@sha256:", StringComparison.Ordinal):
                await PullByDigestAsync(context);
                return true;
            default:
                return false;
        }
    }

    private async Task CreateExecAsync(HttpContext context, string id)
    {
        string body;
        using (var reader = new StreamReader(context.Request.Body))
        {
            body = await reader.ReadToEndAsync();
        }

        if (!Exists(id))
        {
            await ErrorAsync(context, 404, $"No such container: {id}");
            return;
        }

        if (!IsRunning(id))
        {
            await ErrorAsync(context, 409, $"container {Find(id)?["Id"]?.GetValue<string>() ?? id} is not running");
            return;
        }

        ExecBodies.Enqueue(body);
        var parsed = JsonNode.Parse(body)!.AsObject();
        var tty = Property(parsed, "Tty")?.GetValue<bool>() == true;
        var command = Property(parsed, "Cmd")?.AsArray().Select(argument => argument!.GetValue<string>()).ToArray() ?? [];
        var created = Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N");
        _execs[created] = (id, tty, command);
        _execExitCodes[created] = -1;
        await JsonAsync(context, $$"""{"Id":"{{created}}"}""", 201);
    }

    private static JsonNode? Property(JsonObject json, string name) =>
        json.FirstOrDefault(property => string.Equals(property.Key, name, StringComparison.OrdinalIgnoreCase)).Value;

    /// <summary>
    /// An exec started without a TTY: 101, then the reply as the engine frames it (a byte for the
    /// stream, three zeros, the length big-endian, the bytes), the exit code recorded, and the
    /// connection closed.
    /// </summary>
    private async Task RunCommandAsync(string execId, PipeReader replayed, IDuplexPipe connection)
    {
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

        var (container, _, command) = _execs[execId];
        var reply = ExecReplies(container, command);
        var output = connection.Output;
        await output.WriteAsync(Encoding.ASCII.GetBytes(
            "HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n"));
        foreach (var (stream, bytes) in new[] { ((byte)1, reply.Stdout), ((byte)2, reply.Stderr) })
        {
            foreach (var part in bytes.Chunk(16 * 1024))
            {
                var frame = new byte[8 + part.Length];
                frame[0] = stream;
                BinaryPrimitives.WriteUInt32BigEndian(frame.AsSpan(4), (uint)part.Length);
                part.CopyTo(frame, 8);
                try
                {
                    await output.WriteAsync(frame);
                }
                catch (Exception error) when (error is IOException or InvalidOperationException or Microsoft.AspNetCore.Connections.ConnectionResetException)
                {
                    // The client stopped reading (an output cap).
                    _execExitCodes[execId] = reply.ExitCode;
                    return;
                }
            }
        }

        _execExitCodes[execId] = reply.ExitCode;
        await output.CompleteAsync();
        await input.CompleteAsync();
    }

    private async Task ArchiveAsync(HttpContext context, string method, string id, string path)
    {
        if (!Exists(id))
        {
            await ErrorAsync(context, 404, $"No such container: {id}");
            return;
        }

        if (method == "PUT")
        {
            using var body = new MemoryStream();
            await context.Request.Body.CopyToAsync(body);
            if (PutRefusal is { } refusal)
            {
                await ErrorAsync(context, refusal.Status, refusal.Message);
                return;
            }

            if (!ArchivePaths.ContainsKey($"{id}:{path}"))
            {
                await ErrorAsync(context, 404, $"Could not find the file {path} in container {id}");
                return;
            }

            PutArchives.Enqueue((id, path, body.ToArray()));
            context.Response.StatusCode = 200;
            return;
        }

        if (!ArchivePaths.TryGetValue($"{id}:{path}", out var known))
        {
            context.Response.StatusCode = 404;
            context.Response.ContentType = "application/json";
            if (method == "GET")
            {
                await context.Response.WriteAsync(new JsonObject { ["message"] = $"Could not find the file {path} in container {id}" }.ToJsonString());
            }

            return;
        }

        context.Response.Headers["X-Docker-Container-Path-Stat"] = Convert.ToBase64String(Encoding.UTF8.GetBytes(known.StatJson));
        context.Response.ContentType = "application/x-tar";
        context.Response.StatusCode = 200;
        if (method == "GET")
        {
            await context.Response.Body.WriteAsync(known.Tar);
        }
    }

    private IEnumerable<JsonNode> HelperSummaries() =>
        _helpers.Keys.Select(helper => (JsonNode)new JsonObject
        {
            ["Id"] = helper,
            ["Names"] = new JsonArray("/agentmate-files-" + helper[..12]),
            ["Labels"] = new JsonObject { ["agentmate.files"] = "1" },
            ["State"] = _helpers[helper] ? "running" : "created",
        });

    private async Task CreateHelperAsync(HttpContext context)
    {
        string body;
        using (var reader = new StreamReader(context.Request.Body))
        {
            body = await reader.ReadToEndAsync();
        }

        CreatedBodies.Enqueue(body);
        var image = Property(JsonNode.Parse(body)!.AsObject(), "Image")?.GetValue<string>() ?? string.Empty;
        if (!HelperImagePresent)
        {
            await ErrorAsync(context, 404, $"No such image: {image}");
            return;
        }

        var id = Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N");
        _helpers[id] = false;
        await JsonAsync(context, $$"""{"Id":"{{id}}","Warnings":[]}""", 201);
    }

    private async Task PullByDigestAsync(HttpContext context)
    {
        if (PullError is { } error)
        {
            await ErrorAsync(context, 500, error);
            return;
        }

        HelperImagePresent = true;
        context.Response.ContentType = "application/json";
        await context.Response.WriteAsync(Read("pull-busybox.ndjson"));
    }
}
