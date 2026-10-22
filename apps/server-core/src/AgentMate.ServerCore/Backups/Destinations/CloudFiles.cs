using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;

namespace AgentMate.ServerCore.Backups.Destinations;

/// <summary>
/// An OAuth refresh token turned into access tokens as needed (E28). A 401 renews the token once and
/// sends the request again. Microsoft rotates refresh tokens on every use, so a new one is handed
/// to <c>rotated</c> to be sealed in place of the old.
/// </summary>
internal sealed class OAuthSession(
    HttpClient http,
    Uri tokenEndpoint,
    Func<string, Dictionary<string, string>> form,
    string refreshToken,
    string driveName,
    Func<string, Task>? rotated = null)
{
    private string _refreshToken = refreshToken;
    private string? _accessToken;
    private DateTimeOffset _expires;

    /// <summary>Sends a request built fresh for each try, with a bearer token, renewing it once on a 401.</summary>
    public async Task<HttpResponseMessage> SendAsync(Func<HttpRequestMessage> build, CancellationToken cancellationToken, HttpCompletionOption completion = HttpCompletionOption.ResponseContentRead)
    {
        for (var attempt = 0; ; attempt++)
        {
            var token = await AccessTokenAsync(force: attempt > 0, cancellationToken);
            using var request = build();
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            HttpResponseMessage response;
            try
            {
                response = await http.SendAsync(request, completion, cancellationToken);
            }
            catch (HttpRequestException error)
            {
                throw new BackupDestinationException($"{driveName} cannot be reached: {error.Message}", error);
            }

            if (response.StatusCode == HttpStatusCode.Unauthorized && attempt == 0)
            {
                response.Dispose();
                continue;
            }

            return response;
        }
    }

    /// <summary>Throws the API's own error, worded for the person, unless the response is a success or an allowed status.</summary>
    public async Task EnsureAsync(HttpResponseMessage response, CancellationToken cancellationToken, params HttpStatusCode[] allowed)
    {
        if (response.IsSuccessStatusCode || allowed.Contains(response.StatusCode))
        {
            return;
        }

        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        throw new BackupDestinationException(string.Create(
            CultureInfo.InvariantCulture,
            $"{driveName} answered {(int)response.StatusCode} {response.ReasonPhrase}: {(body.Length > 300 ? body[..300] : body)}"));
    }

    private async Task<string> AccessTokenAsync(bool force, CancellationToken cancellationToken)
    {
        if (!force && _accessToken is not null && DateTimeOffset.UtcNow < _expires)
        {
            return _accessToken;
        }

        using var content = new FormUrlEncodedContent(form(_refreshToken));
        HttpResponseMessage response;
        try
        {
            response = await http.PostAsync(tokenEndpoint, content, cancellationToken);
        }
        catch (HttpRequestException error)
        {
            throw new BackupDestinationException($"{driveName} cannot be reached: {error.Message}", error);
        }

        using (response)
        {
            var text = await response.Content.ReadAsStringAsync(cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                throw new BackupDestinationException($"{driveName} refused the saved sign-in. Edit the destination and sign in again.");
            }

            var json = JsonNode.Parse(text) ?? throw new BackupDestinationException($"{driveName} sent an unreadable token.");
            _accessToken = json["access_token"]?.GetValue<string>() ?? throw new BackupDestinationException($"{driveName} sent no access token.");
            var lifetime = json["expires_in"]?.GetValue<int>() ?? 3600;
            _expires = DateTimeOffset.UtcNow.AddSeconds(Math.Max(60, lifetime - 60));
            if (json["refresh_token"]?.GetValue<string>() is { Length: > 0 } next && next != _refreshToken)
            {
                _refreshToken = next;
                if (rotated is not null)
                {
                    await rotated(next);
                }
            }

            return _accessToken;
        }
    }
}

/// <summary>Shared by both drives: a whole download into a temporary file, and reading a chunk.</summary>
internal static class CloudTransfers
{
    public static async Task<Stream> DownloadAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        var file = RemotePaths.TemporaryFile();
        try
        {
            await using (var body = await response.Content.ReadAsStreamAsync(cancellationToken))
            {
                await body.CopyToAsync(file, cancellationToken);
            }

            file.Position = 0;
            return file;
        }
        catch
        {
            await file.DisposeAsync();
            throw;
        }
    }

    public static async Task<int> FillAsync(Stream stream, byte[] buffer, CancellationToken cancellationToken)
    {
        var total = 0;
        while (total < buffer.Length)
        {
            var read = await stream.ReadAsync(buffer.AsMemory(total), cancellationToken);
            if (read == 0)
            {
                break;
            }

            total += read;
        }

        return total;
    }

    public static ByteArrayContent Chunk(byte[] buffer, int length, long from, long total)
    {
        var content = new ByteArrayContent(buffer, 0, length);
        content.Headers.ContentRange = new ContentRangeHeaderValue(from, from + length - 1, total);
        content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        return content;
    }

    public static StringContent Json(JsonNode body) => new(body.ToJsonString(), Encoding.UTF8, "application/json");
}

/// <summary>
/// One folder in Google Drive (REST v3), signed in with the person's own OAuth client and the
/// drive.file scope, so it sees only what it made. Uploads are resumable, in chunks of whole
/// 256 KiB. Drive allows two files of one name; an upload deletes the older ones afterwards.
/// </summary>
internal sealed class GoogleDriveFiles : ICloudFiles
{
    private const string Api = "https://www.googleapis.com/drive/v3/files";
    private const string Upload = "https://www.googleapis.com/upload/drive/v3/files";
    private const string FolderType = "application/vnd.google-apps.folder";

    private readonly OAuthSession _session;
    private readonly string _folderName;
    private readonly int _chunkBytes;
    private string? _folderId;

    public GoogleDriveFiles(HttpClient http, string clientId, string? clientSecret, string refreshToken, string folderName, int chunkBytes = 8 * 1024 * 1024)
    {
        if (chunkBytes <= 0 || chunkBytes % (256 * 1024) != 0)
        {
            throw new ArgumentOutOfRangeException(nameof(chunkBytes), "Google takes chunks of whole 256 KiB.");
        }

        _folderName = folderName;
        _chunkBytes = chunkBytes;
        _session = new OAuthSession(
            http,
            new Uri("https://oauth2.googleapis.com/token"),
            refresh => new Dictionary<string, string>
            {
                ["client_id"] = clientId,
                ["client_secret"] = clientSecret ?? string.Empty,
                ["refresh_token"] = refresh,
                ["grant_type"] = "refresh_token",
            },
            refreshToken,
            "Google Drive");
    }

    public async Task<IReadOnlyList<CloudFile>> ListAsync(CancellationToken cancellationToken)
    {
        var folder = await FolderAsync(cancellationToken);
        return await QueryAsync($"'{folder}' in parents and trashed = false", cancellationToken);
    }

    public async Task PutAsync(string name, Stream content, long length, IProgress<long>? progress, CancellationToken cancellationToken)
    {
        var folder = await FolderAsync(cancellationToken);
        var metadata = new JsonObject { ["name"] = name, ["parents"] = new JsonArray(folder) };
        Uri location;
        using (var started = await _session.SendAsync(
            () =>
            {
                var request = new HttpRequestMessage(HttpMethod.Post, $"{Upload}?uploadType=resumable&fields=id") { Content = CloudTransfers.Json(metadata) };
                request.Headers.Add("X-Upload-Content-Length", length.ToString(CultureInfo.InvariantCulture));
                request.Headers.Add("X-Upload-Content-Type", "application/octet-stream");
                return request;
            },
            cancellationToken))
        {
            await _session.EnsureAsync(started, cancellationToken);
            location = started.Headers.Location ?? throw new BackupDestinationException("Google Drive started no upload.");
        }

        var buffer = new byte[(int)Math.Min(_chunkBytes, Math.Max(length, 1))];
        string? id = null;
        for (long sent = 0; sent < length;)
        {
            var read = await CloudTransfers.FillAsync(content, buffer, cancellationToken);
            if (read == 0)
            {
                throw new BackupDestinationException($"{name} ended before its size.");
            }

            var from = sent;
            using var response = await _session.SendAsync(
                () => new HttpRequestMessage(HttpMethod.Put, location) { Content = CloudTransfers.Chunk(buffer, read, from, length) },
                cancellationToken);
            if (response.StatusCode != (HttpStatusCode)308)
            {
                await _session.EnsureAsync(response, cancellationToken);
                id = JsonNode.Parse(await response.Content.ReadAsStringAsync(cancellationToken))?["id"]?.GetValue<string>();
            }

            sent += read;
            progress?.Report(read);
        }

        foreach (var older in (await ListAsync(cancellationToken)).Where(file => file.Name == name && file.Id != id))
        {
            await DeleteAsync(older, cancellationToken);
        }
    }

    public async Task<Stream> OpenAsync(CloudFile file, CancellationToken cancellationToken)
    {
        using var response = await _session.SendAsync(() => new HttpRequestMessage(HttpMethod.Get, $"{Api}/{file.Id}?alt=media"), cancellationToken, HttpCompletionOption.ResponseHeadersRead);
        await _session.EnsureAsync(response, cancellationToken);
        return await CloudTransfers.DownloadAsync(response, cancellationToken);
    }

    public async Task DeleteAsync(CloudFile file, CancellationToken cancellationToken)
    {
        using var response = await _session.SendAsync(() => new HttpRequestMessage(HttpMethod.Delete, $"{Api}/{file.Id}"), cancellationToken);
        await _session.EnsureAsync(response, cancellationToken, HttpStatusCode.NotFound);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    private async Task<string> FolderAsync(CancellationToken cancellationToken)
    {
        if (_folderId is not null)
        {
            return _folderId;
        }

        var escaped = _folderName.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("'", "\\'", StringComparison.Ordinal);
        var found = await QueryAsync($"name = '{escaped}' and mimeType = '{FolderType}' and trashed = false", cancellationToken);
        if (found.Count > 0)
        {
            return _folderId = found[0].Id;
        }

        using var response = await _session.SendAsync(
            () => new HttpRequestMessage(HttpMethod.Post, $"{Api}?fields=id") { Content = CloudTransfers.Json(new JsonObject { ["name"] = _folderName, ["mimeType"] = FolderType }) },
            cancellationToken);
        await _session.EnsureAsync(response, cancellationToken);
        return _folderId = JsonNode.Parse(await response.Content.ReadAsStringAsync(cancellationToken))?["id"]?.GetValue<string>()
            ?? throw new BackupDestinationException("Google Drive made no folder.");
    }

    private async Task<List<CloudFile>> QueryAsync(string query, CancellationToken cancellationToken)
    {
        var files = new List<CloudFile>();
        string? page = null;
        do
        {
            var uri = $"{Api}?q={Uri.EscapeDataString(query)}&fields={Uri.EscapeDataString("nextPageToken,files(id,name,size)")}&pageSize=1000&spaces=drive"
                + (page is null ? string.Empty : "&pageToken=" + Uri.EscapeDataString(page));
            using var response = await _session.SendAsync(() => new HttpRequestMessage(HttpMethod.Get, uri), cancellationToken);
            await _session.EnsureAsync(response, cancellationToken);
            var json = JsonNode.Parse(await response.Content.ReadAsStringAsync(cancellationToken));
            foreach (var file in json?["files"]?.AsArray() ?? [])
            {
                files.Add(new CloudFile(
                    file!["id"]!.GetValue<string>(),
                    file["name"]!.GetValue<string>(),
                    long.TryParse(file["size"]?.GetValue<string>(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var size) ? size : 0));
            }

            page = json?["nextPageToken"]?.GetValue<string>();
        }
        while (page is not null);

        return files;
    }
}

/// <summary>
/// A folder in the OneDrive app folder (Microsoft Graph), signed in with the person's own app and
/// the Files.ReadWrite.AppFolder scope. Uploads go through an upload session in chunks of whole
/// 320 KiB, sent without the bearer token as Graph requires; a name is replaced, not doubled.
/// </summary>
internal sealed class OneDriveFiles : ICloudFiles
{
    private const string Graph = "https://graph.microsoft.com/v1.0/me/drive";

    private readonly HttpClient _http;
    private readonly OAuthSession _session;
    private readonly string _folder;
    private readonly int _chunkBytes;

    public OneDriveFiles(HttpClient http, string clientId, string refreshToken, string folderName, Func<string, Task> rotated, int chunkBytes = 10 * 1024 * 1024)
    {
        if (chunkBytes <= 0 || chunkBytes % (320 * 1024) != 0)
        {
            throw new ArgumentOutOfRangeException(nameof(chunkBytes), "Graph takes chunks of whole 320 KiB.");
        }

        _http = http;
        _folder = Uri.EscapeDataString(folderName);
        _chunkBytes = chunkBytes;
        _session = new OAuthSession(
            http,
            new Uri("https://login.microsoftonline.com/common/oauth2/v2.0/token"),
            refresh => new Dictionary<string, string>
            {
                ["client_id"] = clientId,
                ["refresh_token"] = refresh,
                ["grant_type"] = "refresh_token",
                ["scope"] = "Files.ReadWrite.AppFolder offline_access",
            },
            refreshToken,
            "OneDrive",
            rotated);
    }

    private string Folder => $"{Graph}/special/approot:/{_folder}";

    public async Task<IReadOnlyList<CloudFile>> ListAsync(CancellationToken cancellationToken)
    {
        var files = new List<CloudFile>();
        string? next = $"{Folder}:/children?$select=id,name,size&$top=1000";
        while (next is not null)
        {
            var uri = next;
            using var response = await _session.SendAsync(() => new HttpRequestMessage(HttpMethod.Get, uri), cancellationToken);
            if (response.StatusCode == HttpStatusCode.NotFound)
            {
                return files;
            }

            await _session.EnsureAsync(response, cancellationToken);
            var json = JsonNode.Parse(await response.Content.ReadAsStringAsync(cancellationToken));
            foreach (var item in json?["value"]?.AsArray() ?? [])
            {
                files.Add(new CloudFile(item!["id"]!.GetValue<string>(), item["name"]!.GetValue<string>(), item["size"]?.GetValue<long>() ?? 0));
            }

            next = json?["@odata.nextLink"]?.GetValue<string>();
        }

        return files;
    }

    public async Task PutAsync(string name, Stream content, long length, IProgress<long>? progress, CancellationToken cancellationToken)
    {
        var item = $"{Folder}/{Uri.EscapeDataString(name)}";
        if (length == 0)
        {
            using var empty = await _session.SendAsync(() => new HttpRequestMessage(HttpMethod.Put, $"{item}:/content") { Content = new ByteArrayContent([]) }, cancellationToken);
            await _session.EnsureAsync(empty, cancellationToken);
            return;
        }

        Uri uploadUrl;
        using (var started = await _session.SendAsync(
            () => new HttpRequestMessage(HttpMethod.Post, $"{item}:/createUploadSession")
            {
                Content = CloudTransfers.Json(new JsonObject { ["item"] = new JsonObject { ["@microsoft.graph.conflictBehavior"] = "replace" } }),
            },
            cancellationToken))
        {
            await _session.EnsureAsync(started, cancellationToken);
            var url = JsonNode.Parse(await started.Content.ReadAsStringAsync(cancellationToken))?["uploadUrl"]?.GetValue<string>();
            uploadUrl = url is null ? throw new BackupDestinationException("OneDrive started no upload.") : new Uri(url);
        }

        var buffer = new byte[(int)Math.Min(_chunkBytes, length)];
        for (long sent = 0; sent < length;)
        {
            var read = await CloudTransfers.FillAsync(content, buffer, cancellationToken);
            if (read == 0)
            {
                throw new BackupDestinationException($"{name} ended before its size.");
            }

            using var request = new HttpRequestMessage(HttpMethod.Put, uploadUrl) { Content = CloudTransfers.Chunk(buffer, read, sent, length) };
            HttpResponseMessage response;
            try
            {
                response = await _http.SendAsync(request, cancellationToken);
            }
            catch (HttpRequestException error)
            {
                throw new BackupDestinationException($"OneDrive cannot be reached: {error.Message}", error);
            }

            using (response)
            {
                await _session.EnsureAsync(response, cancellationToken);
            }

            sent += read;
            progress?.Report(read);
        }
    }

    public async Task<Stream> OpenAsync(CloudFile file, CancellationToken cancellationToken)
    {
        using var response = await _session.SendAsync(() => new HttpRequestMessage(HttpMethod.Get, $"{Graph}/items/{file.Id}/content"), cancellationToken, HttpCompletionOption.ResponseHeadersRead);
        await _session.EnsureAsync(response, cancellationToken);
        return await CloudTransfers.DownloadAsync(response, cancellationToken);
    }

    public async Task DeleteAsync(CloudFile file, CancellationToken cancellationToken)
    {
        using var response = await _session.SendAsync(() => new HttpRequestMessage(HttpMethod.Delete, $"{Graph}/items/{file.Id}"), cancellationToken);
        await _session.EnsureAsync(response, cancellationToken, HttpStatusCode.NotFound);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;
}
