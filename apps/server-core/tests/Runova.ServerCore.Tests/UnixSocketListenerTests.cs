using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Hosting;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Tests;

/// <summary>
/// On a real server the core only exists as a Unix socket that the root user and the runova
/// group can open. These tests run the actual Kestrel listener, so they need Linux.
/// </summary>
[SupportedOSPlatform("linux")]
public sealed class UnixSocketListenerTests : IDisposable
{
    private readonly string _directory = Path.Combine(Path.GetTempPath(), $"runova-core-{Guid.NewGuid():N}");

    private string SocketPath => Path.Combine(_directory, "core.sock");

    [Fact]
    public async Task The_socket_serves_health_and_is_limited_to_owner_and_group()
    {
        Assert.SkipUnless(OperatingSystem.IsLinux(), "Unix socket permissions are a Linux concern.");

        await using var app = await StartAsync();

        Assert.Equal(UnixSocketFile.SocketMode, File.GetUnixFileMode(SocketPath));
        Assert.Equal(HttpStatusCode.OK, await GetHealthStatusAsync());
    }

    [Fact]
    public async Task A_socket_left_behind_by_a_crash_is_replaced()
    {
        Assert.SkipUnless(OperatingSystem.IsLinux(), "Unix socket permissions are a Linux concern.");
        Directory.CreateDirectory(_directory);
        StaleUnixSocket.Create(SocketPath);

        Assert.True(File.Exists(SocketPath));

        await using var app = await StartAsync();

        Assert.Equal(UnixSocketFile.SocketMode, File.GetUnixFileMode(SocketPath));
        Assert.Equal(HttpStatusCode.OK, await GetHealthStatusAsync());
    }

    [Fact]
    public async Task A_socket_another_process_is_serving_is_never_taken_over()
    {
        Assert.SkipUnless(OperatingSystem.IsLinux(), "Unix socket permissions are a Linux concern.");
        Directory.CreateDirectory(_directory);
        using var live = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
        live.Bind(new UnixDomainSocketEndPoint(SocketPath));
        live.Listen();

        var error = await Assert.ThrowsAsync<InvalidOperationException>(StartAsync);

        Assert.Contains("already", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_audit_trail_records_the_unix_user_on_the_other_end()
    {
        Assert.SkipUnless(OperatingSystem.IsLinux(), "SO_PEERCRED is Linux only.");
        await using var app = await StartAsync();
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        Guid deviceId;
        await using (var scope = app.Services.CreateAsyncScope())
        {
            var users = scope.ServiceProvider.GetRequiredService<UserManager<CoreUser>>();
            var maria = new CoreUser { UserName = "maria" };
            Assert.True((await users.CreateAsync(maria, "correct horse battery staple")).Succeeded);
            var db = scope.ServiceProvider.GetRequiredService<CoreDbContext>();
            var device = new Device { Id = Guid.NewGuid(), UserId = maria.Id, Name = "laptop", PublicKey = key.ExportSubjectPublicKeyInfo() };
            db.Devices.Add(device);
            await db.SaveChangesAsync(TestContext.Current.CancellationToken);
            deviceId = device.Id;
        }

        using var client = SocketClient();
        var challengeResponse = await client.PostAsJsonAsync(
            "/api/v1/auth/challenge",
            new ChallengeRequest(deviceId, AuthPurpose.Login),
            CoreJson.Options,
            TestContext.Current.CancellationToken);
        var challenge = (await challengeResponse.Content.ReadFromJsonAsync<ChallengeResponse>(CoreJson.Options, TestContext.Current.CancellationToken))!;
        var message = AuthMessage.For(AuthPurpose.Login, challenge.ChallengeId, challenge.Nonce, deviceId, null);
        var signature = Convert.ToBase64String(key.SignData(
            Encoding.UTF8.GetBytes(message),
            HashAlgorithmName.SHA256,
            DSASignatureFormat.IeeeP1363FixedFieldConcatenation));
        await client.PostAsJsonAsync(
            "/api/v1/auth/login",
            new LoginRequest(challenge.ChallengeId, deviceId, signature, "maria", "not the password at all"),
            CoreJson.Options,
            TestContext.Current.CancellationToken);

        await using var check = app.Services.CreateAsyncScope();
        var audited = await check.ServiceProvider.GetRequiredService<CoreDbContext>()
            .AuditEvents.SingleAsync(TestContext.Current.CancellationToken);
        Assert.Equal("auth.login", audited.Action);
        Assert.Equal(CurrentUid(), audited.PeerUid);
    }

    public void Dispose() => TestFolders.Delete(_directory);

    /// <summary>This process's uid, from /proc rather than a libc call.</summary>
    private static int CurrentUid()
    {
        var line = File.ReadLines("/proc/self/status").First(l => l.StartsWith("Uid:", StringComparison.Ordinal));
        return int.Parse(line.Split('\t', StringSplitOptions.RemoveEmptyEntries)[1], System.Globalization.CultureInfo.InvariantCulture);
    }

    private HttpClient SocketClient()
    {
        var handler = new SocketsHttpHandler
        {
            ConnectCallback = async (_, cancellationToken) =>
            {
                var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
                await socket.ConnectAsync(new UnixDomainSocketEndPoint(SocketPath), cancellationToken);
                return new NetworkStream(socket, ownsSocket: true);
            },
        };
        return new HttpClient(handler, disposeHandler: true) { BaseAddress = new Uri("http://runova-core") };
    }

    private async Task<WebApplication> StartAsync()
    {
        var app = CoreApplication.Build(
        [
            $"--Core:Listen:SocketPath={SocketPath}",
            $"--Core:DataDirectory={Path.Combine(_directory, "data")}",
            "--environment",
            "Testing",
        ]);
        try
        {
            await app.StartAsync(TestContext.Current.CancellationToken);
            return app;
        }
        catch
        {
            await app.DisposeAsync();
            throw;
        }
    }

    private async Task<HttpStatusCode> GetHealthStatusAsync()
    {
        using var handler = new SocketsHttpHandler
        {
            ConnectCallback = async (_, cancellationToken) =>
            {
                var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
                await socket.ConnectAsync(new UnixDomainSocketEndPoint(SocketPath), cancellationToken);
                return new NetworkStream(socket, ownsSocket: true);
            },
        };
        using var client = new HttpClient(handler) { BaseAddress = new Uri("http://runova-core") };
        var response = await client.GetAsync("/api/v1/health", TestContext.Current.CancellationToken);
        return response.StatusCode;
    }
}
