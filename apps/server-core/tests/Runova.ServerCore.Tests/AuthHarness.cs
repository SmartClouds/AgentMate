using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Tests;

/// <summary>
/// A core with one user and one enrolled device, and a client that signs challenges the way the
/// desktop does. The clock is fake unless a test needs real time (TOTP codes are real-time).
/// </summary>
public sealed class AuthHarness : IAsyncDisposable
{
    public const string Password = "correct horse battery staple";

    private readonly WebApplicationFactory<Program> _app;
    private readonly CoreFactory _factory = new();

    private AuthHarness(FakeTimeProvider? clock, Action<IServiceCollection, FakeTimeProvider?>? configure)
    {
        Clock = clock;
        _app = _factory.WithWebHostBuilder(builder =>
        {
            if (clock is not null)
            {
                builder.ConfigureServices(services => services.AddSingleton<TimeProvider>(clock));
            }

            if (configure is not null)
            {
                builder.ConfigureServices(services => configure(services, clock));
            }
        });
        Client = _app.CreateClient();
    }

    public FakeTimeProvider? Clock { get; }

    public HttpClient Client { get; }

    public IServiceProvider Services => _app.Services;

    public ECDsa DeviceKey { get; } = ECDsa.Create(ECCurve.NamedCurves.nistP256);

    public Guid DeviceId { get; private set; }

    public Guid UserId { get; private set; }

    /// <param name="role">The seeded user's role.</param>
    /// <param name="fakeClock">A FakeTimeProvider as the core's clock, or the real one.</param>
    /// <param name="services">Registrations after the core's own, with the fake clock if there is one.</param>
    public static async Task<AuthHarness> CreateAsync(
        string role = CoreRoles.Owner,
        bool fakeClock = true,
        Action<IServiceCollection, FakeTimeProvider?>? services = null)
    {
        var harness = new AuthHarness(fakeClock ? new FakeTimeProvider(DateTimeOffset.UtcNow) : null, services);
        await harness.SeedAsync(role);
        return harness;
    }

    private async Task SeedAsync(string role)
    {
        await using var scope = Services.CreateAsyncScope();
        var users = scope.ServiceProvider.GetRequiredService<UserManager<CoreUser>>();
        var user = new CoreUser { UserName = "maria" };
        Check(await users.CreateAsync(user, Password));
        Check(await users.AddToRoleAsync(user, role));
        UserId = user.Id;
        DeviceId = await AddDeviceAsync(DeviceKey);
    }

    public async Task<Guid> AddDeviceAsync(ECDsa key)
    {
        await using var scope = Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<CoreDbContext>();
        var device = new Device
        {
            Id = Guid.NewGuid(),
            UserId = UserId,
            Name = "laptop",
            PublicKey = key.ExportSubjectPublicKeyInfo(),
        };
        db.Devices.Add(device);
        await db.SaveChangesAsync();
        return device.Id;
    }

    public async Task<ChallengeResponse> ChallengeAsync(AuthPurpose purpose, Guid? sessionId = null, Guid? deviceId = null)
    {
        var (challenge, response) = await TryChallengeAsync(purpose, sessionId, deviceId);
        Assert.True(challenge is not null, await response.Content.ReadAsStringAsync());
        return challenge!;
    }

    /// <summary>The challenge, or null and the refusal (a revoked device is turned away right here).</summary>
    public async Task<(ChallengeResponse? Challenge, HttpResponseMessage Response)> TryChallengeAsync(
        AuthPurpose purpose,
        Guid? sessionId = null,
        Guid? deviceId = null)
    {
        var response = await Client.PostAsJsonAsync(
            "/api/v1/auth/challenge",
            new ChallengeRequest(deviceId ?? DeviceId, purpose, sessionId),
            CoreJson.Options);
        return response.IsSuccessStatusCode
            ? ((await response.Content.ReadFromJsonAsync<ChallengeResponse>(CoreJson.Options))!, response)
            : (null, response);
    }

    public string Sign(ChallengeResponse challenge, AuthPurpose purpose, Guid? sessionId = null, ECDsa? key = null, Guid? deviceId = null)
    {
        var message = AuthMessage.For(purpose, challenge.ChallengeId, challenge.Nonce, deviceId ?? DeviceId, sessionId);
        var signature = (key ?? DeviceKey).SignData(
            Encoding.UTF8.GetBytes(message),
            HashAlgorithmName.SHA256,
            DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        return Convert.ToBase64String(signature);
    }

    public async Task<HttpResponseMessage> LoginAsync(
        string password = Password,
        string? totpCode = null,
        ChallengeResponse? challenge = null,
        string? recoveryCode = null)
    {
        if (challenge is null)
        {
            var (issued, refusal) = await TryChallengeAsync(AuthPurpose.Login);
            if (issued is null)
            {
                return refusal;
            }

            challenge = issued;
        }

        return await Client.PostAsJsonAsync(
            "/api/v1/auth/login",
            new LoginRequest(
                challenge.ChallengeId,
                DeviceId,
                Sign(challenge, AuthPurpose.Login),
                "maria",
                password,
                totpCode,
                recoveryCode),
            CoreJson.Options);
    }

    public async Task<SignedInResponse> SignInAsync(string? totpCode = null)
    {
        var response = await LoginAsync(totpCode: totpCode);
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        return (await response.Content.ReadFromJsonAsync<SignedInResponse>(CoreJson.Options))!;
    }

    public async Task<HttpResponseMessage> RenewAsync(Guid sessionId)
    {
        var (challenge, refusal) = await TryChallengeAsync(AuthPurpose.Renew, sessionId);
        if (challenge is null)
        {
            return refusal;
        }

        return await Client.PostAsJsonAsync(
            "/api/v1/auth/renew",
            new RenewRequest(challenge.ChallengeId, sessionId, Sign(challenge, AuthPurpose.Renew, sessionId)),
            CoreJson.Options);
    }

    public static async Task<AuthErrorCode> ErrorOf(HttpResponseMessage response)
    {
        var error = await response.Content.ReadFromJsonAsync<AuthError>(CoreJson.Options);
        return error!.Code;
    }

    /// <summary>
    /// A hub connection the way the app makes one: WebSockets only, the token in a header, and the
    /// core's JSON shape (enums as camelCase names).
    /// </summary>
    public HubConnection Hub(string accessToken) =>
        new HubConnectionBuilder()
            .WithUrl(
                new Uri(_app.Server.BaseAddress, "hubs/core"),
                Microsoft.AspNetCore.Http.Connections.HttpTransportType.WebSockets,
                options =>
                {
                    options.SkipNegotiation = true;
                    options.WebSocketFactory = async (context, cancellationToken) =>
                    {
                        var client = _app.Server.CreateWebSocketClient();
                        client.ConfigureRequest = request =>
                            request.Headers.Authorization = $"Bearer {accessToken}";
                        return await client.ConnectAsync(context.Uri, cancellationToken);
                    };
                })
            .AddJsonProtocol(options => CoreJson.Configure(options.PayloadSerializerOptions))
            .Build();

    /// <summary>The code an authenticator app shows by this harness's clock, or that many 30-second steps away.</summary>
    public string TotpCodeNow(string base32Key, int stepsAway = 0) =>
        TotpCode(base32Key, (Clock?.GetUtcNow() ?? DateTimeOffset.UtcNow).AddSeconds(30 * stepsAway));

    /// <summary>The current RFC 6238 code for an Identity authenticator key (base32).</summary>
    public static string TotpCode(string base32Key, DateTimeOffset? at = null)
    {
        var key = Base32Decode(base32Key);
        var counter = (at ?? DateTimeOffset.UtcNow).ToUnixTimeSeconds() / 30;
        Span<byte> counterBytes = stackalloc byte[8];
        System.Buffers.Binary.BinaryPrimitives.WriteInt64BigEndian(counterBytes, counter);
        // RFC 6238 authenticator codes are defined over HMAC-SHA1; this mirrors the apps.
#pragma warning disable CA5350
        var hash = HMACSHA1.HashData(key, counterBytes);
#pragma warning restore CA5350
        var offset = hash[^1] & 0x0f;
        var binary = ((hash[offset] & 0x7f) << 24) | (hash[offset + 1] << 16) | (hash[offset + 2] << 8) | hash[offset + 3];
        return (binary % 1_000_000).ToString("D6", System.Globalization.CultureInfo.InvariantCulture);
    }

    private static byte[] Base32Decode(string input)
    {
        const string alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
        var bits = 0;
        var value = 0;
        var output = new List<byte>();
        foreach (var character in input.TrimEnd('=').ToUpperInvariant())
        {
            value = (value << 5) | alphabet.IndexOf(character, StringComparison.Ordinal);
            bits += 5;
            if (bits >= 8)
            {
                output.Add((byte)(value >> (bits - 8)));
                bits -= 8;
            }
        }

        return [.. output];
    }

    private static void Check(IdentityResult result) =>
        Assert.True(result.Succeeded, string.Join("; ", result.Errors.Select(e => e.Description)));

    public async ValueTask DisposeAsync()
    {
        DeviceKey.Dispose();
        Client.Dispose();
        await _app.DisposeAsync();
        await _factory.DisposeAsync();
    }
}
