using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.DirectTls;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Tests;

/// <summary>
/// The direct TLS listener on a real Kestrel, on loopback: off until turned on, a client
/// certificate for an enrolled, unrevoked device key or no connection at all, the server's key
/// matching the pin the app reads over SSH, the usual guards and sign-in on top, and the port
/// closed again when the mode goes off.
/// </summary>
public sealed class DirectTlsListenerTests : IAsyncLifetime
{
    private readonly string _directory = Path.Combine(Path.GetTempPath(), $"runova-tls-{Guid.NewGuid():N}");
    private readonly int _basePort = DirectTlsClient.FreePort();
    private readonly int _tlsPort = DirectTlsClient.FreePort();
    private readonly ECDsa _key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
    private WebApplication? _app;
    private Guid _deviceId;

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private WebApplication App => _app!;

    private DirectTlsManager Manager => App.Services.GetRequiredService<DirectTlsManager>();

    public async ValueTask InitializeAsync()
    {
        _app = await StartAsync();
        _deviceId = await AddDeviceAsync(_key);
    }

    public async ValueTask DisposeAsync()
    {
        if (_app is not null)
        {
            await _app.DisposeAsync();
        }

        _key.Dispose();
        TestFolders.Delete(_directory);
    }

    [Fact]
    public async Task Nothing_listens_until_the_mode_is_turned_on()
    {
        var status = await Manager.StatusAsync(Cancel);

        Assert.False(status.Enabled);
        Assert.False(status.Listening);
        Assert.False(DirectTlsClient.Accepts(_tlsPort));
        Assert.Equal(44, status.Pin.Length);
    }

    [Fact]
    public async Task An_enrolled_device_reaches_the_core_and_the_server_key_matches_the_pin()
    {
        var status = await EnableAsync();
        string? seen = null;
        using var certificate = DirectTlsClient.CertificateFor(_key);
        using var client = DirectTlsClient.Create(_tlsPort, status.Pin, certificate, pin => seen = pin);

        var response = await client.GetAsync(new Uri("/api/v1/health", UriKind.Relative), Cancel);

        Assert.True(status.Listening);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(status.Pin, seen);
    }

    [Fact]
    public async Task A_connection_without_a_client_certificate_is_refused()
    {
        var status = await EnableAsync();
        using var client = DirectTlsClient.Create(_tlsPort, status.Pin, clientCertificate: null);

        await Assert.ThrowsAnyAsync<HttpRequestException>(() => client.GetAsync(new Uri("/api/v1/health", UriKind.Relative), Cancel));
    }

    [Fact]
    public async Task A_certificate_for_a_key_the_core_does_not_know_is_refused()
    {
        var status = await EnableAsync();
        using var stranger = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        using var certificate = DirectTlsClient.CertificateFor(stranger);
        using var client = DirectTlsClient.Create(_tlsPort, status.Pin, certificate);

        await Assert.ThrowsAnyAsync<HttpRequestException>(() => client.GetAsync(new Uri("/api/v1/health", UriKind.Relative), Cancel));
    }

    [Fact]
    public async Task A_server_key_that_does_not_match_the_pin_is_refused()
    {
        await EnableAsync();
        using var certificate = DirectTlsClient.CertificateFor(_key);
        using var client = DirectTlsClient.Create(_tlsPort, Convert.ToBase64String(new byte[32]), certificate);

        await Assert.ThrowsAnyAsync<HttpRequestException>(() => client.GetAsync(new Uri("/api/v1/health", UriKind.Relative), Cancel));
    }

    [Fact]
    public async Task A_revoked_device_is_refused_on_a_new_connection_and_on_one_already_open()
    {
        var status = await EnableAsync();
        using var certificate = DirectTlsClient.CertificateFor(_key);
        using var open = DirectTlsClient.Create(_tlsPort, status.Pin, certificate, keepAlive: true);
        Assert.Equal(HttpStatusCode.OK, (await open.GetAsync(new Uri("/api/v1/health", UriKind.Relative), Cancel)).StatusCode);

        await RevokeAsync(_deviceId);
        using var fresh = DirectTlsClient.Create(_tlsPort, status.Pin, certificate);

        await Assert.ThrowsAnyAsync<HttpRequestException>(() => fresh.GetAsync(new Uri("/api/v1/health", UriKind.Relative), Cancel));
        await Assert.ThrowsAnyAsync<HttpRequestException>(() => open.GetAsync(new Uri("/api/v1/health", UriKind.Relative), Cancel));
    }

    [Fact]
    public async Task The_sign_in_and_tokens_are_bound_to_the_device_of_the_certificate()
    {
        var status = await EnableAsync();
        using var otherKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var otherDevice = await AddDeviceAsync(otherKey);
        var mine = await SignInOverTcpAsync(_key, _deviceId);
        var theirs = await SignInOverTcpAsync(otherKey, otherDevice);
        using var certificate = DirectTlsClient.CertificateFor(_key);
        using var client = DirectTlsClient.Create(_tlsPort, status.Pin, certificate);

        var ownChallenge = await client.PostAsJsonAsync("/api/v1/auth/challenge", new ChallengeRequest(_deviceId, AuthPurpose.Login), CoreJson.Options, Cancel);
        var otherChallenge = await client.PostAsJsonAsync("/api/v1/auth/challenge", new ChallengeRequest(otherDevice, AuthPurpose.Login), CoreJson.Options, Cancel);
        var ownToken = await GetHubAsync(client, mine);
        var otherToken = await GetHubAsync(client, theirs);
        var enroll = await client.PostAsJsonAsync("/api/v1/auth/enroll", new { code = "x", userName = "maria", password = "y", publicKey = "z", deviceName = "n" }, CoreJson.Options, Cancel);

        Assert.Equal(HttpStatusCode.OK, ownChallenge.StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, otherChallenge.StatusCode);
        Assert.NotEqual(HttpStatusCode.Unauthorized, ownToken);
        Assert.Equal(HttpStatusCode.Unauthorized, otherToken);
        Assert.Equal(HttpStatusCode.Forbidden, enroll.StatusCode);
    }

    [Fact]
    public async Task The_host_and_origin_guards_still_apply()
    {
        var status = await EnableAsync();
        using var certificate = DirectTlsClient.CertificateFor(_key);
        using var client = DirectTlsClient.Create(_tlsPort, status.Pin, certificate);

        using var fromBrowser = new HttpRequestMessage(HttpMethod.Get, "/api/v1/health");
        fromBrowser.Headers.Add("Origin", "https://evil.example");
        using var otherHost = new HttpRequestMessage(HttpMethod.Get, "/api/v1/health");
        otherHost.Headers.Host = "core.example.com";

        Assert.Equal(HttpStatusCode.Forbidden, (await client.SendAsync(fromBrowser, Cancel)).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.SendAsync(otherHost, Cancel)).StatusCode);
    }

    [Fact]
    public async Task An_address_outside_the_sources_never_gets_a_handshake()
    {
        var status = await EnableAsync(["192.0.2.0/24"]);
        string? seen = null;
        using var certificate = DirectTlsClient.CertificateFor(_key);
        using var client = DirectTlsClient.Create(_tlsPort, status.Pin, certificate, pin => seen = pin);

        var refused = await Record.ExceptionAsync(() => client.GetAsync(new Uri("/api/v1/health", UriKind.Relative), Cancel));

        // The core resets the connection right after accepting it. When the reset lands before
        // HttpClient reads the socket's remote address, that read throws a bare SocketException
        // instead of an HttpRequestException. Either way the server never sent its certificate.
        Assert.True(refused is HttpRequestException or SocketException, refused?.ToString() ?? "The request went through.");
        Assert.Null(seen);

        var widened = await EnableAsync(["192.0.2.0/24", "127.0.0.0/8"]);
        using var again = DirectTlsClient.Create(_tlsPort, status.Pin, certificate);

        Assert.Equal(["192.0.2.0/24", "127.0.0.0/8"], widened.Sources);
        Assert.Equal(HttpStatusCode.OK, (await again.GetAsync(new Uri("/api/v1/health", UriKind.Relative), Cancel)).StatusCode);
    }

    [Fact]
    public async Task Turning_it_off_closes_the_port()
    {
        await EnableAsync();
        Assert.True(DirectTlsClient.Accepts(_tlsPort));

        var status = await Manager.DisableAsync("maria", Cancel);

        Assert.False(status.Enabled);
        Assert.False(status.Listening);
        Assert.Null(status.Error);
        Assert.False(DirectTlsClient.Accepts(_tlsPort));
        Assert.True(DirectTlsClient.Accepts(_basePort));
    }

    [Fact]
    public async Task The_mode_and_the_certificate_survive_a_restart()
    {
        var before = await EnableAsync();
        await App.DisposeAsync();
        _app = null;

        _app = await StartAsync();
        var after = await WaitForListeningAsync();

        Assert.True(after.Enabled);
        Assert.True(after.Listening);
        Assert.Equal(before.Pin, after.Pin);
    }

    private async Task<DirectTlsStatus> EnableAsync(string[]? sources = null) =>
        await Manager.EnableAsync(new DirectTlsRequest(_tlsPort, sources), "maria", [22], Cancel);

    private async Task<DirectTlsStatus> WaitForListeningAsync()
    {
        for (var attempt = 0; attempt < 100; attempt++)
        {
            var status = await Manager.StatusAsync(Cancel);
            if (status.Listening)
            {
                return status;
            }

            await Task.Delay(50, Cancel);
        }

        return await Manager.StatusAsync(Cancel);
    }

    private async Task<WebApplication> StartAsync()
    {
        var app = CoreApplication.Build(
        [
            $"--Core:Listen:TcpPort={_basePort}",
            $"--Core:DataDirectory={_directory}",
            "--Core:DirectTls:LoopbackOnly=true",
            "--environment",
            "Testing",
        ]);
        await app.StartAsync(Cancel);
        return app;
    }

    private async Task<Guid> AddDeviceAsync(ECDsa key)
    {
        await using var scope = App.Services.CreateAsyncScope();
        var users = scope.ServiceProvider.GetRequiredService<UserManager<CoreUser>>();
        var user = await users.FindByNameAsync("maria");
        if (user is null)
        {
            user = new CoreUser { UserName = "maria" };
            Assert.True((await users.CreateAsync(user, AuthHarness.Password)).Succeeded);
            Assert.True((await users.AddToRoleAsync(user, CoreRoles.Owner)).Succeeded);
        }

        var db = scope.ServiceProvider.GetRequiredService<CoreDbContext>();
        var device = new Device { Id = Guid.NewGuid(), UserId = user.Id, Name = "laptop", PublicKey = key.ExportSubjectPublicKeyInfo() };
        db.Devices.Add(device);
        await db.SaveChangesAsync(Cancel);
        return device.Id;
    }

    private async Task RevokeAsync(Guid deviceId)
    {
        await using var scope = App.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<CoreDbContext>();
        var device = await db.Devices.SingleAsync(d => d.Id == deviceId, Cancel);
        device.RevokedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        await db.SaveChangesAsync(Cancel);
    }

    /// <summary>Signs in over the plain loopback listener, as the app would over SSH.</summary>
    private async Task<string> SignInOverTcpAsync(ECDsa key, Guid deviceId)
    {
        using var client = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{_basePort}") };
        client.DefaultRequestHeaders.Host = "runova-core";
        var challengeResponse = await client.PostAsJsonAsync("/api/v1/auth/challenge", new ChallengeRequest(deviceId, AuthPurpose.Login), CoreJson.Options, Cancel);
        var challenge = (await challengeResponse.Content.ReadFromJsonAsync<ChallengeResponse>(CoreJson.Options, Cancel))!;
        var message = AuthMessage.For(AuthPurpose.Login, challenge.ChallengeId, challenge.Nonce, deviceId, null);
        var signature = Convert.ToBase64String(key.SignData(Encoding.UTF8.GetBytes(message), HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation));
        var login = await client.PostAsJsonAsync("/api/v1/auth/login", new LoginRequest(challenge.ChallengeId, deviceId, signature, "maria", AuthHarness.Password), CoreJson.Options, Cancel);
        var signedIn = await login.Content.ReadFromJsonAsync<SignedInResponse>(CoreJson.Options, Cancel);
        return signedIn!.AccessToken;
    }

    private static async Task<HttpStatusCode> GetHubAsync(HttpClient client, string token)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, "/hubs/core");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return (await client.SendAsync(request, Cancel)).StatusCode;
    }
}
