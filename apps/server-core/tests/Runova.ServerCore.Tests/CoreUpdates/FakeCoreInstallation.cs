using System.Net;
using System.Security.Cryptography;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Hosting;
using Runova.ServerCore.Updates;

namespace Runova.ServerCore.Tests.CoreUpdates;

/// <summary>
/// An installed core as far as the updater can tell: a release it runs from and a staging folder
/// in the temp folder. Unpacking and scheduling are only recorded, with what the tarball held.
/// </summary>
internal sealed class FakeCoreInstallation : ICoreInstallation, IDisposable
{
    public const string Running = "/opt/runova-core/releases/1.70.0-aaaaaaaaaaaa";

    private readonly List<(string Release, string Version, byte[] Content)> _switches = [];

    public CoreLayout Layout { get; set; } = CoreLayout.Runova;

    public string? CurrentRelease { get; set; } = Running;

    public string? Rid { get; set; } = "linux-x64";

    public string StagingDirectory { get; } = TestFolders.Create("core-update");

    /// <summary>Thrown by the next unpack, when set.</summary>
    public Exception? Fail { get; set; }

    public IReadOnlyList<(string Release, string Version, byte[] Content)> Switches
    {
        get
        {
            lock (_switches)
            {
                return [.. _switches];
            }
        }
    }

    public string ReleaseDirectory(string version, string sha256) =>
        SystemdCoreInstallation.ReleaseDirectoryIn("/opt/runova-core/releases", version, sha256);

    public async Task UnpackAndScheduleAsync(string tarball, string release, string version, CancellationToken cancellationToken)
    {
        if (Fail is { } fail)
        {
            throw fail;
        }

        var content = await File.ReadAllBytesAsync(tarball, cancellationToken);
        lock (_switches)
        {
            _switches.Add((release, version, content));
        }
    }

    public void Dispose()
    {
        if (Directory.Exists(StagingDirectory))
        {
            Directory.Delete(StagingDirectory, recursive: true);
        }
    }
}

/// <summary>A release tarball's bytes and the request that describes them.</summary>
internal sealed record FakeRelease(byte[] Content, CoreUpdateRequest Request)
{
    public static FakeRelease Create(string version = "1.72.0", string rid = "linux-x64", bool withUrl = true)
    {
        var content = RandomNumberGenerator.GetBytes(300_000);
        var file = $"runova-core-{version}-{rid}.tar.gz";
        return new FakeRelease(
            content,
            new CoreUpdateRequest(
                version,
                file,
                Convert.ToHexStringLower(SHA256.HashData(content)),
                content.Length,
                withUrl ? $"https://github.com/SmartClouds/Runova/releases/download/v{version}/{file}" : null));
    }
}

/// <summary>GitHub as the core's download sees it: answers from a function, and counts the requests.</summary>
internal sealed class FakeGitHub : HttpMessageHandler
{
    private int _requests;

    public Func<HttpRequestMessage, HttpResponseMessage> Respond { get; set; } = _ => new HttpResponseMessage(HttpStatusCode.NotFound);

    public int Requests => _requests;

    public void Serve(byte[] content) => Respond = _ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(content) };

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        Interlocked.Increment(ref _requests);
        return Task.FromResult(Respond(request));
    }
}

internal sealed class FakeHttpClients(HttpMessageHandler handler) : IHttpClientFactory
{
    public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
}
