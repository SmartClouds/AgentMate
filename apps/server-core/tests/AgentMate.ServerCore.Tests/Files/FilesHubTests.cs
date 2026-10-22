using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using AgentMate.ServerCore.Contracts;
using AgentMate.ServerCore.Data;
using AgentMate.ServerCore.Endpoints;
using AgentMate.ServerCore.Security;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace AgentMate.ServerCore.Tests.Files;

/// <summary>
/// The file manager through the hub and the REST transfers, on the pretend engine: Admins only,
/// a session only for whoever opened it, refusals coded as "[files:code] sentence" (and JSON
/// { code, message } over REST), byte ranges, and every change and transfer in the audit trail.
/// </summary>
public sealed class FilesHubTests
{
    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private static async Task<(HubConnection Hub, string Token)> ConnectAsync(AuthHarness harness)
    {
        var signedIn = await harness.SignInAsync();
        var hub = harness.Hub(signedIn.AccessToken);
        await hub.StartAsync(Cancel);
        return (hub, signedIn.AccessToken);
    }

    private static Task<FileSessionInfo> OpenAsync(HubConnection hub, string container) =>
        hub.InvokeAsync<FileSessionInfo>(nameof(ICoreHub.FilesOpen), new FileTarget(FileTargetKind.Container, container), Cancel);

    private static HttpRequestMessage Request(HttpMethod method, string token, Guid session, string path, string? query = null) =>
        new(method, $"{FileEndpoints.Prefix}/{session:D}/content?path={Uri.EscapeDataString(path)}{query}")
        {
            Headers = { Authorization = new AuthenticationHeaderValue("Bearer", token) },
        };

    private static async Task<HttpResponseMessage> PutAsync(AuthHarness harness, string token, Guid session, string path, byte[] bytes, string? mode = "644")
    {
        using var request = Request(HttpMethod.Put, token, session, path, mode is null ? null : $"&mode={mode}");
        request.Content = new ByteArrayContent(bytes);
        return await harness.Client.SendAsync(request, Cancel);
    }

    private static async Task<HttpResponseMessage> GetAsync(AuthHarness harness, string token, Guid session, string path, string? range = null)
    {
        using var request = Request(HttpMethod.Get, token, session, path);
        if (range is not null)
        {
            request.Headers.TryAddWithoutValidation("Range", range);
        }

        return await harness.Client.SendAsync(request, Cancel);
    }

    private static async Task<FileErrorJson> ErrorOf(HttpResponseMessage response) =>
        (await response.Content.ReadFromJsonAsync<FileErrorJson>(CoreJson.Options, Cancel))!;

    private static async Task<List<(string Action, string Result, string? Target, string? Parameters)>> AuditAsync(AuthHarness harness)
    {
        await using var scope = harness.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<CoreDbContext>();
        return [.. (await db.AuditEvents.OrderBy(e => e.Id).ToListAsync(Cancel)).Select(e => (e.Action, e.Result, e.Target, e.Parameters))];
    }

    /// <summary>A second Admin, "omar", with a device of his own, signed in the way the app does it.</summary>
    private static async Task<string> SignInOmarAsync(AuthHarness harness)
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        Guid deviceId;
        await using (var scope = harness.Services.CreateAsyncScope())
        {
            var users = scope.ServiceProvider.GetRequiredService<UserManager<CoreUser>>();
            var omar = new CoreUser { UserName = "omar" };
            Assert.True((await users.CreateAsync(omar, AuthHarness.Password)).Succeeded);
            Assert.True((await users.AddToRoleAsync(omar, CoreRoles.Admin)).Succeeded);
            var db = scope.ServiceProvider.GetRequiredService<CoreDbContext>();
            var device = new Device { Id = Guid.NewGuid(), UserId = omar.Id, Name = "desk", PublicKey = key.ExportSubjectPublicKeyInfo() };
            db.Devices.Add(device);
            await db.SaveChangesAsync(Cancel);
            deviceId = device.Id;
        }

        var challenge = await harness.ChallengeAsync(AuthPurpose.Login, deviceId: deviceId);
        var response = await harness.Client.PostAsJsonAsync(
            "/api/v1/auth/login",
            new LoginRequest(challenge.ChallengeId, deviceId, harness.Sign(challenge, AuthPurpose.Login, key: key, deviceId: deviceId), "omar", AuthHarness.Password, null, null),
            CoreJson.Options,
            Cancel);
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync(Cancel));
        return (await response.Content.ReadFromJsonAsync<SignedInResponse>(CoreJson.Options, Cancel))!.AccessToken;
    }

    [Theory]
    [InlineData(CoreRoles.Viewer)]
    [InlineData(CoreRoles.Operator)]
    public async Task Below_admin_the_hub_and_the_transfers_are_refused(string role)
    {
        await using var harness = await AuthHarness.CreateAsync(role);
        var (hub, token) = await ConnectAsync(harness);
        await using var _ = hub;

        var refused = await Assert.ThrowsAsync<HubException>(() => OpenAsync(hub, "toolbox"));
        var list = await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync<FileListing>(nameof(ICoreHub.FilesList), new FilePathRequest(Guid.NewGuid(), "/"), Cancel));
        var download = await GetAsync(harness, token, Guid.NewGuid(), "/etc/hostname");
        var upload = await PutAsync(harness, token, Guid.NewGuid(), "/tmp/x", [1]);

        Assert.Contains("unauthorized", refused.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("unauthorized", list.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(HttpStatusCode.Forbidden, download.StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, upload.StatusCode);
        Assert.DoesNotContain(await AuditAsync(harness), e => e.Action.StartsWith("files.", StringComparison.Ordinal) && e.Result == "success");
    }

    [Fact]
    public async Task An_admin_browses_and_changes_files_and_every_change_is_audited()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Admin);
        var (hub, _) = await ConnectAsync(harness);
        await using var _hub = hub;

        var session = await OpenAsync(hub, "toolbox");
        var listing = await hub.InvokeAsync<FileListing>(nameof(ICoreHub.FilesList), new FilePathRequest(session.SessionId, "/srv"), Cancel);
        await hub.InvokeAsync(nameof(ICoreHub.FilesMkdir), new FilePathRequest(session.SessionId, "/srv/reports"), Cancel);
        await hub.InvokeAsync(nameof(ICoreHub.FilesRename), new FileRenameRequest(session.SessionId, "/srv/notes.txt", "/srv/reports/notes.txt"), Cancel);
        await hub.InvokeAsync(nameof(ICoreHub.FilesChmod), new FileChmodRequest(session.SessionId, "/srv/reports/notes.txt", 0x180), Cancel);
        var stat = await hub.InvokeAsync<FileEntry?>(nameof(ICoreHub.FilesStat), new FilePathRequest(session.SessionId, "/srv/reports/notes.txt"), Cancel);
        var missing = await hub.InvokeAsync<FileEntry?>(nameof(ICoreHub.FilesStat), new FilePathRequest(session.SessionId, "/srv/nothing"), Cancel);
        var real = await hub.InvokeAsync<string>(nameof(ICoreHub.FilesRealpath), new FilePathRequest(session.SessionId, "/srv/reports/../reports"), Cancel);
        await hub.InvokeAsync(nameof(ICoreHub.FilesRemove), new FileRemoveRequest(session.SessionId, "/srv/reports/notes.txt", false), Cancel);
        await hub.InvokeAsync(nameof(ICoreHub.FilesRemove), new FileRemoveRequest(session.SessionId, "/srv/reports", true), Cancel);
        await hub.InvokeAsync(nameof(ICoreHub.FilesClose), session.SessionId, Cancel);

        Assert.Contains(listing.Entries, e => e.Name == "notes.txt");
        Assert.Equal(0x8180, stat!.Mode);
        Assert.Null(missing);
        Assert.Equal("/srv/reports", real);
        var audit = await AuditAsync(harness);
        foreach (var action in new[] { "files.open", "files.mkdir", "files.rename", "files.chmod", "files.remove" })
        {
            Assert.Contains(audit, e => e.Action == action && e.Result == "success" && e.Target == "container:toolbox");
        }

        Assert.Contains(audit, e => e.Action == "files.chmod" && e.Parameters!.Contains("\"600\"", StringComparison.Ordinal));
        Assert.Contains(audit, e => e.Action == "files.rename" && e.Parameters!.Contains("/srv/reports/notes.txt", StringComparison.Ordinal));
        var closed = await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync<FileListing>(nameof(ICoreHub.FilesList), new FilePathRequest(session.SessionId, "/"), Cancel));
        Assert.Contains("[files:sessionGone] ", closed.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Refusals_arrive_coded_and_the_refused_changes_are_audited()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Admin);
        var (hub, _) = await ConnectAsync(harness);
        await using var _hub = hub;
        var stopped = await OpenAsync(hub, "migrate-once");

        var rename = await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync(nameof(ICoreHub.FilesRename), new FileRenameRequest(stopped.SessionId, "/srv/app/migrate.js", "/srv/app/m.js"), Cancel));
        var missing = await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync<FileListing>(nameof(ICoreHub.FilesList), new FilePathRequest(stopped.SessionId, "/no/such"), Cancel));
        var badName = await Assert.ThrowsAsync<HubException>(() => OpenAsync(hub, "not a name!"));
        var gone = await Assert.ThrowsAsync<HubException>(() => OpenAsync(hub, "no-such-container"));
        var relative = await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync(nameof(ICoreHub.FilesMkdir), new FilePathRequest(stopped.SessionId, "srv/x"), Cancel));

        // SignalR puts its own words in front: "An unexpected error occurred invoking 'FilesRename' on the server. HubException: ".
        Assert.EndsWith(" HubException: [files:unsupported] The container is stopped. Start it to rename, delete or change permissions.", rename.Message, StringComparison.Ordinal);
        Assert.Contains("[files:notFound] ", missing.Message, StringComparison.Ordinal);
        Assert.Contains("[files:invalidInput] ", badName.Message, StringComparison.Ordinal);
        Assert.Contains("[files:targetGone] ", gone.Message, StringComparison.Ordinal);
        Assert.Contains("[files:invalidInput] ", relative.Message, StringComparison.Ordinal);
        Assert.False(stopped.Capabilities.Rename);
        var audit = await AuditAsync(harness);
        Assert.Contains(audit, e => e.Action == "files.rename" && e.Result == "denied" && e.Target == "container:migrate-once" && e.Parameters!.Contains("unsupported", StringComparison.Ordinal));
        Assert.Contains(audit, e => e.Action == "files.open" && e.Result == "denied" && e.Target == "container:not a name!");
        Assert.Contains(audit, e => e.Action == "files.open" && e.Result == "failed" && e.Target == "container:no-such-container");
        Assert.Contains(audit, e => e.Action == "files.mkdir" && e.Result == "denied");
    }

    [Fact]
    public async Task Another_users_session_is_gone_for_them_over_the_hub_and_over_rest()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Admin);
        var (hub, mariaToken) = await ConnectAsync(harness);
        await using var _hub = hub;
        var session = await OpenAsync(hub, "toolbox");
        var omarToken = await SignInOmarAsync(harness);
        await using var omar = harness.Hub(omarToken);
        await omar.StartAsync(Cancel);

        var listed = await Assert.ThrowsAsync<HubException>(() => omar.InvokeAsync<FileListing>(nameof(ICoreHub.FilesList), new FilePathRequest(session.SessionId, "/"), Cancel));
        var closed = await Assert.ThrowsAsync<HubException>(() => omar.InvokeAsync(nameof(ICoreHub.FilesClose), session.SessionId, Cancel));
        var download = await GetAsync(harness, omarToken, session.SessionId, "/srv/notes.txt");
        var upload = await PutAsync(harness, omarToken, session.SessionId, "/srv/x.txt", [1, 2]);

        Assert.Contains("[files:sessionGone] ", listed.Message, StringComparison.Ordinal);
        Assert.Contains("[files:sessionGone] ", closed.Message, StringComparison.Ordinal);
        Assert.Equal(HttpStatusCode.Gone, download.StatusCode);
        Assert.Equal("sessionGone", (await ErrorOf(download)).Code);
        Assert.Equal(HttpStatusCode.Gone, upload.StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await GetAsync(harness, mariaToken, session.SessionId, "/srv/notes.txt")).StatusCode);
    }

    [Fact]
    public async Task A_file_goes_up_and_comes_down_whole_or_by_range()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Admin);
        var (hub, token) = await ConnectAsync(harness);
        await using var _hub = hub;
        var session = await OpenAsync(hub, "toolbox");

        var put = await PutAsync(harness, token, session.SessionId, "/srv/r.bin", "0123456789"u8.ToArray(), mode: "600");
        var whole = await GetAsync(harness, token, session.SessionId, "/srv/r.bin");
        var middle = await GetAsync(harness, token, session.SessionId, "/srv/r.bin", "bytes=2-4");
        var tail = await GetAsync(harness, token, session.SessionId, "/srv/r.bin", "bytes=8-");
        var last = await GetAsync(harness, token, session.SessionId, "/srv/r.bin", "bytes=-3");
        var short_ = await GetAsync(harness, token, session.SessionId, "/srv/r.bin", "bytes=8-20");
        var past = await GetAsync(harness, token, session.SessionId, "/srv/r.bin", "bytes=10-");

        Assert.Equal(HttpStatusCode.OK, put.StatusCode);
        using (var json = JsonDocument.Parse(await put.Content.ReadAsStringAsync(Cancel)))
        {
            Assert.Equal("r.bin", json.RootElement.GetProperty("name").GetString());
            Assert.Equal(0x8180, json.RootElement.GetProperty("mode").GetInt32());
            Assert.Equal(10, json.RootElement.GetProperty("size").GetInt64());
        }

        Assert.Equal(HttpStatusCode.OK, whole.StatusCode);
        Assert.Equal(10, whole.Content.Headers.ContentLength);
        Assert.Equal("application/octet-stream", whole.Content.Headers.ContentType!.MediaType);
        var mtime = long.Parse(Assert.Single(whole.Headers.GetValues(FileEndpoints.MtimeHeader)), System.Globalization.CultureInfo.InvariantCulture);
        Assert.Equal(0, mtime % 1000);
        Assert.Equal("0123456789", await whole.Content.ReadAsStringAsync(Cancel));
        Assert.Equal(HttpStatusCode.PartialContent, middle.StatusCode);
        Assert.Equal("bytes 2-4/10", middle.Content.Headers.ContentRange!.ToString());
        Assert.Equal("234", await middle.Content.ReadAsStringAsync(Cancel));
        Assert.Equal("89", await tail.Content.ReadAsStringAsync(Cancel));
        Assert.Equal("789", await last.Content.ReadAsStringAsync(Cancel));
        Assert.Equal("89", await short_.Content.ReadAsStringAsync(Cancel));
        Assert.Equal(HttpStatusCode.RequestedRangeNotSatisfiable, past.StatusCode);
        var audit = await AuditAsync(harness);
        Assert.Contains(audit, e => e.Action == "files.upload" && e.Result == "success" && e.Target == "container:toolbox" && e.Parameters!.Contains("/srv/r.bin", StringComparison.Ordinal));
        Assert.Equal(5, audit.Count(e => e.Action == "files.download" && e.Result == "success"));
    }

    [Fact]
    public async Task An_upload_larger_than_the_cores_usual_request_limit_streams_through()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Admin);
        var (hub, token) = await ConnectAsync(harness);
        await using var _hub = hub;
        var session = await hub.InvokeAsync<FileSessionInfo>(nameof(ICoreHub.FilesOpen), new FileTarget(FileTargetKind.Volume, "shop_uploads"), Cancel);
        var bytes = RandomNumberGenerator.GetBytes(12 * 1024 * 1024);

        var put = await PutAsync(harness, token, session.SessionId, "/backup.tar", bytes);
        var back = await GetAsync(harness, token, session.SessionId, "/backup.tar");

        Assert.Equal(HttpStatusCode.OK, put.StatusCode);
        Assert.Equal(SHA256.HashData(bytes), SHA256.HashData(await back.Content.ReadAsByteArrayAsync(Cancel)));
    }

    [Fact]
    public async Task Transfers_are_refused_with_a_code_and_a_fitting_status()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Admin);
        var (hub, token) = await ConnectAsync(harness);
        await using var _hub = hub;
        var session = await OpenAsync(hub, "toolbox");

        var missing = await GetAsync(harness, token, session.SessionId, "/srv/nothing");
        var folder = await GetAsync(harness, token, session.SessionId, "/srv");
        var ontoFolder = await PutAsync(harness, token, session.SessionId, "/srv", [1]);
        var badMode = await PutAsync(harness, token, session.SessionId, "/srv/x", [1], mode: "9z");
        var noSession = await GetAsync(harness, token, Guid.NewGuid(), "/srv/notes.txt");
        // The test client always works out a length, so this request is made by hand, chunked.
        var server = (Microsoft.AspNetCore.TestHost.TestServer)harness.Services.GetRequiredService<Microsoft.AspNetCore.Hosting.Server.IServer>();
        var unsized = await server.SendAsync(
            context =>
            {
                context.Request.Method = "PUT";
                context.Request.Path = $"{FileEndpoints.Prefix}/{session.SessionId:D}/content";
                context.Request.QueryString = new Microsoft.AspNetCore.Http.QueryString("?path=%2Fsrv%2Funsized.txt&mode=644");
                context.Request.Headers.Authorization = $"Bearer {token}";
                context.Request.Headers.TransferEncoding = "chunked";
                context.Request.Body = new MemoryStream("abc"u8.ToArray());
            },
            Cancel);

        var missingError = await ErrorOf(missing);
        Assert.Equal((HttpStatusCode.NotFound, "notFound"), (missing.StatusCode, missingError.Code));
        Assert.False(string.IsNullOrWhiteSpace(missingError.Message));
        Assert.Equal((HttpStatusCode.Conflict, "isDirectory"), (folder.StatusCode, (await ErrorOf(folder)).Code));
        Assert.Equal((HttpStatusCode.Conflict, "isDirectory"), (ontoFolder.StatusCode, (await ErrorOf(ontoFolder)).Code));
        Assert.Equal((HttpStatusCode.BadRequest, "invalidInput"), (badMode.StatusCode, (await ErrorOf(badMode)).Code));
        Assert.Equal((HttpStatusCode.Gone, "sessionGone"), (noSession.StatusCode, (await ErrorOf(noSession)).Code));
        Assert.Equal(StatusCodes411, unsized.Response.StatusCode);
        Assert.Contains("\"code\":\"invalidInput\"", await new StreamReader(unsized.Response.Body).ReadToEndAsync(Cancel), StringComparison.Ordinal);
        var audit = await AuditAsync(harness);
        Assert.Contains(audit, e => e.Action == "files.download" && e.Result == "failed" && e.Parameters!.Contains("notFound", StringComparison.Ordinal));
        Assert.Contains(audit, e => e.Action == "files.upload" && e.Result == "failed" && e.Parameters!.Contains("isDirectory", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("bytes=0-0", 10, 0, 1)]
    [InlineData("bytes=0-", 10, 0, 10)]
    [InlineData("bytes=9-9", 10, 9, 1)]
    [InlineData("bytes=-20", 10, 0, 10)]
    [InlineData("bytes=10-", 10, 0, -1)]
    [InlineData("bytes=0-", 0, 0, -1)]
    public void A_single_range_is_read_and_clipped_to_the_file(string header, long size, long start, long length)
    {
        Assert.Equal((start, length), FileEndpoints.ParseRange(header, size));
    }

    [Theory]
    [InlineData("bytes=0-1,4-5")]
    [InlineData("lines=1-2")]
    [InlineData("bytes=5-2")]
    [InlineData("nonsense")]
    public void Anything_but_one_byte_range_sends_the_whole_file(string header)
    {
        Assert.Null(FileEndpoints.ParseRange(header, 10));
    }

    private const int StatusCodes411 = 411;

    private sealed record FileErrorJson(string Code, string Message);
}
