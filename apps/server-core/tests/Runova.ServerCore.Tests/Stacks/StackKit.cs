using System.Formats.Tar;
using System.IO.Compression;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Jobs;

namespace Runova.ServerCore.Tests.Stacks;

/// <summary>What the stack tests share: a signed-in hub, the REST uploads the app makes, and jobs followed to their end.</summary>
internal sealed class StackKit(AuthHarness harness, HubConnection hub, string token) : IAsyncDisposable
{
    public const string Secret = "pg-very-secret-1234";

    public const string Compose = """
        services:
          web:
            image: nginx:1.29
            restart: unless-stopped
            environment:
              DB_PASSWORD: ${DB_PASSWORD}
            ports:
              - "8080:80"
        """;

    public static readonly string Env = $"DB_PASSWORD=\"{Secret}\"\n";

    public AuthHarness Harness { get; } = harness;

    public HubConnection Hub { get; } = hub;

    public static CancellationToken Cancel => TestContext.Current.CancellationToken;

    public static async Task<StackKit> CreateAsync(string role)
    {
        var harness = await AuthHarness.CreateAsync(role, fakeClock: false);
        var signedIn = await harness.SignInAsync();
        var hub = harness.Hub(signedIn.AccessToken);
        await hub.StartAsync(Cancel);
        return new StackKit(harness, hub, signedIn.AccessToken);
    }

    public string DataDirectory => Harness.Services.GetRequiredService<Runova.ServerCore.Hosting.CoreDirectories>().Data;

    public Task<StackInfo> CreateStackAsync(string name = "site") =>
        Hub.InvokeAsync<StackInfo>(nameof(ICoreHub.CreateStack), new CreateStackRequest(name), Cancel);

    public static StackRevisionUpload Upload(string compose = Compose, string? env = null, string[]? proxied = null, string[]? acknowledged = null, bool context = false) =>
        new(compose, env ?? Env, proxied ?? ["web"], acknowledged ?? [], context, new StackSource(ProjectName: "Shop", ComposePath: "compose.yaml"));

    public async Task<HttpResponseMessage> PostRevisionAsync(Guid stackId, StackRevisionUpload upload)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/stacks/{stackId}/revisions")
        {
            Content = JsonContent.Create(upload, options: CoreJson.Options),
        };
        return await SendAsync(request);
    }

    public async Task<StackRevisionInfo> UploadAsync(Guid stackId, StackRevisionUpload upload)
    {
        using var response = await PostRevisionAsync(stackId, upload);
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync(Cancel));
        return (await response.Content.ReadFromJsonAsync<StackRevisionInfo>(CoreJson.Options, Cancel))!;
    }

    public async Task<HttpResponseMessage> PutContextAsync(Guid stackId, int number, Stream archive, string? sha = null)
    {
        using var request = new HttpRequestMessage(HttpMethod.Put, $"/api/v1/stacks/{stackId}/revisions/{number}/context")
        {
            Content = new StreamContent(archive),
        };
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/gzip");
        if (sha is not null)
        {
            request.Headers.Add(StackEndpointsHeader, sha);
        }

        return await SendAsync(request);
    }

    public async Task<(JobInfo Job, List<JobLogLine> Log)> RunAsync(JobInfo started)
    {
        var finished = await Harness.Services.GetRequiredService<JobEngine>().WhenFinishedAsync(started.Id, Cancel).WaitAsync(TimeSpan.FromSeconds(60), Cancel);
        var log = new List<JobLogLine>();
        await foreach (var item in Hub.StreamAsync<JobStreamItem>(nameof(ICoreHub.StreamJob), started.Id, 0L, Cancel))
        {
            log.AddRange(item.Lines);
        }

        return (finished, log);
    }

    public Task<JobInfo> DeployAsync(Guid stackId, int number) =>
        Hub.InvokeAsync<JobInfo>(nameof(ICoreHub.DeployStack), new StackRevisionRef(stackId, number), Cancel);

    public Task<StackDetails> GetAsync(Guid stackId) => Hub.InvokeAsync<StackDetails>(nameof(ICoreHub.GetStack), stackId, Cancel);

    public async Task<List<(string Action, string Result, string? Target, string? Parameters)>> AuditAsync()
    {
        await using var scope = Harness.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<CoreDbContext>();
        return [.. (await db.AuditEvents.OrderBy(e => e.Id).ToListAsync(Cancel)).Select(e => (e.Action, e.Result, e.Target, e.Parameters))];
    }

    public static MemoryStream Archive(params TarEntry[] entries)
    {
        var archive = new MemoryStream();
        using (var gzip = new GZipStream(archive, CompressionLevel.Fastest, leaveOpen: true))
        using (var writer = new TarWriter(gzip, TarEntryFormat.Pax, leaveOpen: true))
        {
            foreach (var entry in entries)
            {
                writer.WriteEntry(entry);
            }
        }

        archive.Position = 0;
        return archive;
    }

    public static PaxTarEntry File(string name, string content) =>
        new(TarEntryType.RegularFile, name) { DataStream = new MemoryStream(Encoding.UTF8.GetBytes(content)) };

    public async ValueTask DisposeAsync()
    {
        await Hub.DisposeAsync();
        await Harness.DisposeAsync();
    }

    private const string StackEndpointsHeader = Endpoints.StackEndpoints.ShaHeader;

    private Task<HttpResponseMessage> SendAsync(HttpRequestMessage request)
    {
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return Harness.Client.SendAsync(request, Cancel);
    }

    /// <summary>Every file under the stacks folder, relative to the data folder, for proving nothing landed outside.</summary>
    public IEnumerable<string> FilesOutsideStacks() =>
        Directory.EnumerateFiles(DataDirectory, "*", SearchOption.AllDirectories)
            .Select(path => Path.GetRelativePath(DataDirectory, path).Replace('\\', '/'))
            .Where(path => !path.StartsWith("stacks/", StringComparison.Ordinal) && !path.StartsWith("jobs/", StringComparison.Ordinal) && !path.StartsWith("keys/", StringComparison.Ordinal) && !path.StartsWith("core.db", StringComparison.Ordinal));

    public Runova.ServerCore.DevHost.Fakes.SimulatedCompose Simulated => Harness.Services.GetRequiredService<Runova.ServerCore.DevHost.Fakes.SimulatedCompose>();

    public static string Sha(MemoryStream archive)
    {
        var sha = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(archive.ToArray()));
        archive.Position = 0;
        return sha;
    }
}
