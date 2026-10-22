using System.Collections.Concurrent;
using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace AgentMate.ServerCore.Tests.Backups;

/// <summary>A file a fake drive holds.</summary>
internal sealed record FakeDriveFile(string Id, string Name, string? Parent, byte[] Bytes, bool Folder = false);

/// <summary>
/// Google's token endpoint and the parts of Drive v3 a backup uses, in memory: refresh tokens for
/// access tokens (which expire when told to), folder search and creation, listing by parent, the
/// resumable upload (chunks of whole 256 KiB, the last one shorter), media downloads and deletes.
/// Every API call is checked for a valid bearer token.
/// </summary>
internal sealed partial class FakeGoogleDrive : HttpMessageHandler
{
    public const string RefreshToken = "1//google-refresh";

    private readonly ConcurrentDictionary<string, FakeDriveFile> _files = new();
    private readonly ConcurrentDictionary<string, (string Name, string Parent, MemoryStream Bytes, long Total)> _sessions = new();
    private string _accessToken = "ya29.first";
    private int _ids;

    public int TokenRequests { get; private set; }

    public List<long> ChunkSizes { get; } = [];

    public IEnumerable<FakeDriveFile> Files => _files.Values;

    public void ExpireAccessToken() => _accessToken = "ya29.expired-" + Guid.NewGuid().ToString("N");

    public void AddFile(string name, string folderName, byte[] bytes)
    {
        var folder = _files.Values.FirstOrDefault(f => f.Folder && f.Name == folderName) ?? Add(folderName, null, [], folder: true);
        Add(name, folder.Id, bytes);
    }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var uri = request.RequestUri!;
        if (uri.Host == "oauth2.googleapis.com")
        {
            var form = await request.Content!.ReadAsStringAsync(cancellationToken);
            TokenRequests++;
            if (!form.Contains("refresh_token=" + Uri.EscapeDataString(RefreshToken), StringComparison.Ordinal) || !form.Contains("client_secret=", StringComparison.Ordinal))
            {
                return Json(HttpStatusCode.BadRequest, new JsonObject { ["error"] = "invalid_grant" });
            }

            _accessToken = "ya29." + Guid.NewGuid().ToString("N");
            return Json(HttpStatusCode.OK, new JsonObject { ["access_token"] = _accessToken, ["expires_in"] = 3599 });
        }

        if (request.Headers.Authorization?.Parameter != _accessToken)
        {
            return Json(HttpStatusCode.Unauthorized, new JsonObject { ["error"] = new JsonObject { ["code"] = 401 } });
        }

        var path = uri.AbsolutePath;
        var query = System.Web.HttpUtility.ParseQueryString(uri.Query);
        if (path == "/drive/v3/files" && request.Method == HttpMethod.Get)
        {
            var q = query["q"] ?? string.Empty;
            IEnumerable<FakeDriveFile> found = _files.Values;
            if (FolderQuery().Match(q) is { Success: true } folder)
            {
                found = found.Where(f => f.Folder && f.Name == folder.Groups[1].Value.Replace("\\'", "'", StringComparison.Ordinal));
            }
            else if (ParentQuery().Match(q) is { Success: true } parent)
            {
                found = found.Where(f => !f.Folder && f.Parent == parent.Groups[1].Value);
            }

            var array = new JsonArray([.. found.Select(f => (JsonNode)new JsonObject { ["id"] = f.Id, ["name"] = f.Name, ["size"] = f.Bytes.Length.ToString(CultureInfo.InvariantCulture) })]);
            return Json(HttpStatusCode.OK, new JsonObject { ["files"] = array });
        }

        if (path == "/drive/v3/files" && request.Method == HttpMethod.Post)
        {
            var body = JsonNode.Parse(await request.Content!.ReadAsStringAsync(cancellationToken))!;
            var created = Add(body["name"]!.GetValue<string>(), null, [], folder: body["mimeType"]?.GetValue<string>() == "application/vnd.google-apps.folder");
            return Json(HttpStatusCode.OK, new JsonObject { ["id"] = created.Id });
        }

        if (path == "/upload/drive/v3/files" && request.Method == HttpMethod.Post && query["uploadType"] == "resumable")
        {
            var body = JsonNode.Parse(await request.Content!.ReadAsStringAsync(cancellationToken))!;
            var total = long.Parse(request.Headers.GetValues("X-Upload-Content-Length").Single(), CultureInfo.InvariantCulture);
            var session = Guid.NewGuid().ToString("N");
            _sessions[session] = (body["name"]!.GetValue<string>(), body["parents"]![0]!.GetValue<string>(), new MemoryStream(), total);
            var response = new HttpResponseMessage(HttpStatusCode.OK);
            response.Headers.Location = new Uri($"https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id={session}");
            return response;
        }

        if (path == "/upload/drive/v3/files" && request.Method == HttpMethod.Put && query["upload_id"] is { } uploadId && _sessions.TryGetValue(uploadId, out var upload))
        {
            var chunk = await request.Content!.ReadAsByteArrayAsync(cancellationToken);
            var range = request.Content.Headers.ContentRange!;
            if (range.From != upload.Bytes.Length || (range.To + 1 < upload.Total && chunk.Length % (256 * 1024) != 0))
            {
                return new HttpResponseMessage(HttpStatusCode.BadRequest);
            }

            ChunkSizes.Add(chunk.Length);
            await upload.Bytes.WriteAsync(chunk, cancellationToken);
            if (upload.Bytes.Length < upload.Total)
            {
                return new HttpResponseMessage((HttpStatusCode)308);
            }

            _sessions.TryRemove(uploadId, out _);
            var created = Add(upload.Name, upload.Parent, upload.Bytes.ToArray());
            return Json(HttpStatusCode.OK, new JsonObject { ["id"] = created.Id });
        }

        if (path.StartsWith("/drive/v3/files/", StringComparison.Ordinal))
        {
            var id = path["/drive/v3/files/".Length..];
            if (!_files.TryGetValue(id, out var file))
            {
                return new HttpResponseMessage(HttpStatusCode.NotFound);
            }

            if (request.Method == HttpMethod.Delete)
            {
                _files.TryRemove(id, out _);
                return new HttpResponseMessage(HttpStatusCode.NoContent);
            }

            if (query["alt"] == "media")
            {
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(file.Bytes) };
            }
        }

        return new HttpResponseMessage(HttpStatusCode.NotImplemented) { Content = new StringContent($"{request.Method} {uri}") };
    }

    private FakeDriveFile Add(string name, string? parent, byte[] bytes, bool folder = false)
    {
        var file = new FakeDriveFile("g" + Interlocked.Increment(ref _ids).ToString(CultureInfo.InvariantCulture), name, parent, bytes, folder);
        _files[file.Id] = file;
        return file;
    }

    private static HttpResponseMessage Json(HttpStatusCode status, JsonNode body) =>
        new(status) { Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json") };

    [GeneratedRegex(@"^name = '((?:[^'\\]|\\')*)' and mimeType = 'application/vnd\.google-apps\.folder' and trashed = false$")]
    private static partial Regex FolderQuery();

    [GeneratedRegex(@"^'([^']+)' in parents and trashed = false$")]
    private static partial Regex ParentQuery();
}

/// <summary>
/// Microsoft's token endpoint and the parts of Graph a backup uses: refresh tokens that rotate on
/// every use, the app folder addressed by path, upload sessions in whole 320 KiB chunks (sent
/// without the bearer token, as Graph requires), item downloads and deletes.
/// </summary>
internal sealed class FakeOneDrive : HttpMessageHandler
{
    private readonly ConcurrentDictionary<string, FakeDriveFile> _files = new();
    private readonly ConcurrentDictionary<string, (string Name, MemoryStream Bytes)> _sessions = new();
    private string _accessToken = "eyJ.first";
    private int _ids;

    private readonly HashSet<string> _issued = ["M.R3_first"];

    /// <summary>The newest refresh token. Older ones stay good until they expire, as Microsoft's do.</summary>
    public string RefreshToken { get; private set; } = "M.R3_first";

    public List<long> ChunkSizes { get; } = [];

    public void ExpireAccessToken() => _accessToken = "eyJ.expired";

    public void AddFile(string name, byte[] bytes) => Add(name, bytes);

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var uri = request.RequestUri!;
        if (uri.Host == "login.microsoftonline.com")
        {
            var form = await request.Content!.ReadAsStringAsync(cancellationToken);
            if (!_issued.Any(token => form.Contains("refresh_token=" + Uri.EscapeDataString(token), StringComparison.Ordinal)))
            {
                return Json(HttpStatusCode.BadRequest, new JsonObject { ["error"] = "invalid_grant" });
            }

            _accessToken = "eyJ." + Guid.NewGuid().ToString("N");
            RefreshToken = "M.R3_" + Guid.NewGuid().ToString("N");
            _issued.Add(RefreshToken);
            return Json(HttpStatusCode.OK, new JsonObject { ["access_token"] = _accessToken, ["refresh_token"] = RefreshToken, ["expires_in"] = 3600 });
        }

        if (uri.Host == "upload.example.net")
        {
            if (request.Headers.Authorization is not null)
            {
                return new HttpResponseMessage(HttpStatusCode.Unauthorized);
            }

            var session = _sessions[uri.AbsolutePath.Trim('/')];
            var chunk = await request.Content!.ReadAsByteArrayAsync(cancellationToken);
            var range = request.Content.Headers.ContentRange!;
            if (range.From != session.Bytes.Length || (range.To + 1 < range.Length && chunk.Length % (320 * 1024) != 0))
            {
                return new HttpResponseMessage(HttpStatusCode.BadRequest);
            }

            ChunkSizes.Add(chunk.Length);
            await session.Bytes.WriteAsync(chunk, cancellationToken);
            if (session.Bytes.Length < range.Length)
            {
                return new HttpResponseMessage(HttpStatusCode.Accepted);
            }

            var created = Add(session.Name, session.Bytes.ToArray());
            return Json(HttpStatusCode.Created, new JsonObject { ["id"] = created.Id });
        }

        if (request.Headers.Authorization?.Parameter != _accessToken)
        {
            return new HttpResponseMessage(HttpStatusCode.Unauthorized);
        }

        var path = Uri.UnescapeDataString(uri.AbsolutePath);
        const string root = "/v1.0/me/drive/special/approot:/";
        if (path.StartsWith(root, StringComparison.Ordinal))
        {
            var rest = path[root.Length..];
            if (rest.EndsWith(":/children", StringComparison.Ordinal))
            {
                var array = new JsonArray([.. _files.Values.Select(f => (JsonNode)new JsonObject { ["id"] = f.Id, ["name"] = f.Name, ["size"] = f.Bytes.Length })]);
                return Json(HttpStatusCode.OK, new JsonObject { ["value"] = array });
            }

            if (rest.EndsWith(":/createUploadSession", StringComparison.Ordinal) && request.Method == HttpMethod.Post)
            {
                var name = rest[..^":/createUploadSession".Length].Split('/')[^1];
                var session = Guid.NewGuid().ToString("N");
                _sessions[session] = (name, new MemoryStream());
                return Json(HttpStatusCode.OK, new JsonObject { ["uploadUrl"] = $"https://upload.example.net/{session}" });
            }

            if (rest.EndsWith(":/content", StringComparison.Ordinal) && request.Method == HttpMethod.Put)
            {
                var created = Add(rest[..^":/content".Length].Split('/')[^1], await request.Content!.ReadAsByteArrayAsync(cancellationToken));
                return Json(HttpStatusCode.Created, new JsonObject { ["id"] = created.Id });
            }
        }

        const string items = "/v1.0/me/drive/items/";
        if (path.StartsWith(items, StringComparison.Ordinal))
        {
            var rest = path[items.Length..];
            var id = rest.Split('/')[0];
            if (!_files.TryGetValue(id, out var file))
            {
                return new HttpResponseMessage(HttpStatusCode.NotFound);
            }

            if (request.Method == HttpMethod.Delete)
            {
                _files.TryRemove(id, out _);
                return new HttpResponseMessage(HttpStatusCode.NoContent);
            }

            if (rest.EndsWith("/content", StringComparison.Ordinal))
            {
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(file.Bytes) };
            }
        }

        return new HttpResponseMessage(HttpStatusCode.NotImplemented) { Content = new StringContent($"{request.Method} {uri}") };
    }

    /// <summary>A name is unique in the folder: an upload replaces, as conflictBehavior=replace asks.</summary>
    private FakeDriveFile Add(string name, byte[] bytes)
    {
        foreach (var same in _files.Values.Where(f => f.Name == name).ToList())
        {
            _files.TryRemove(same.Id, out _);
        }

        var file = new FakeDriveFile("o" + Interlocked.Increment(ref _ids).ToString(CultureInfo.InvariantCulture), name, null, bytes);
        _files[file.Id] = file;
        return file;
    }

    private static HttpResponseMessage Json(HttpStatusCode status, JsonNode body) =>
        new(status) { Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json") };
}
