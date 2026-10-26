using System.Globalization;
using System.Net.Security;
using System.Security.Cryptography.X509Certificates;
using Microsoft.Extensions.Logging.Abstractions;
using Runova.ServerCore.Certificates.Acme;

namespace Runova.ServerCore.SystemTests.Acme;

/// <summary>
/// Let's Encrypt's Pebble and pebble-challtestsrv in Docker, on a network of their own: Pebble
/// asks challtestsrv for every DNS name, which points all of them at itself and answers HTTP-01
/// and DNS-01 with what the tests publish. Both publish their ports on 127.0.0.1 only. The test
/// process trusts Pebble's test CA (minica, copied out of the container) for these connections
/// and nothing else. Without a Docker engine for Linux containers, the tests skip.
/// </summary>
public class PebbleFixture : IAsyncLifetime
{
    public const string PebbleImage = "ghcr.io/letsencrypt/pebble:2.10.1";
    public const string ChallTestServerImage = "ghcr.io/letsencrypt/pebble-challtestsrv:2.10.1";

    private const int AcmePort = 14000;
    private const int ManagementPort = 15000;
    private const int ChallengeManagementPort = 8055;

    // Pebble's own test configuration with Retry-After cut to a second and one profile, so the
    // client never waits long and every certificate lives 90 days.
    private const string Configuration = """
        {
          "pebble": {
            "listenAddress": "0.0.0.0:14000",
            "managementListenAddress": "0.0.0.0:15000",
            "certificate": "test/certs/localhost/cert.pem",
            "privateKey": "test/certs/localhost/key.pem",
            "httpPort": HTTP_PORT,
            "tlsPort": 5001,
            "ocspResponderURL": "",
            "externalAccountBindingRequired": false,
            "domainBlocklist": ["blocked-domain.example"],
            "retryAfter": { "authz": 1, "order": 1 },
            "keyAlgorithm": "ecdsa",
            "profiles": {
              "default": { "description": "Ninety days", "validityPeriod": 7776000 }
            }
          }
        }
        """;

    private static readonly TimeSpan _commandTimeout = TimeSpan.FromMinutes(1);
    private static readonly TimeSpan _pullTimeout = TimeSpan.FromMinutes(10);

    private readonly string _suffix = Guid.NewGuid().ToString("N")[..10];
    private readonly int _httpPort;

    public PebbleFixture()
        : this(5002)
    {
    }

    /// <param name="httpPort">Where Pebble connects for HTTP-01: 5002 is challtestsrv's, 80 a real web server's.</param>
    protected PebbleFixture(int httpPort) => _httpPort = httpPort;
    private readonly string _workFolder = Path.Combine(Path.GetTempPath(), $"runova-pebble-{Guid.NewGuid():N}");
    private readonly List<string> _containers = [];
    private bool _networkCreated;
    private HttpClient? _pebbleHttp;
    private HttpClient? _challengeHttp;

    /// <summary>Why the tests skip, or null when Pebble is running.</summary>
    public string? SkipReason { get; private set; }

    public Uri DirectoryUrl { get; private set; } = new("https://127.0.0.1/dir");

    public Uri ManagementUrl { get; private set; } = new("https://127.0.0.1/");

    /// <summary>The HTTP-01 publisher and DNS-01 hook, through challtestsrv.</summary>
    internal ChallTestServer Challenges { get; private set; } = null!;

    /// <summary>The Docker network Pebble and challtestsrv share; a web server joins it to be validated.</summary>
    public string Network => $"runova-acme-{_suffix}";

    private string PebbleName => $"runova-pebble-{_suffix}";

    private string ChallTestServerName => $"runova-challtestsrv-{_suffix}";

    /// <summary>A client for Pebble, with the production handler settings plus trust in Pebble's test CA.</summary>
    internal AcmeClient CreateClient() =>
        new(
            _pebbleHttp!,
            new AcmeClientOptions { DirectoryUrl = DirectoryUrl, PollTimeout = TimeSpan.FromMinutes(2) },
            TimeProvider.System,
            NullLogger<AcmeClient>.Instance);

    /// <summary>The root of Pebble's chain number <paramref name="index"/>, made fresh at every start.</summary>
    public async Task<X509Certificate2> GetRootAsync(int index, CancellationToken cancellationToken)
    {
        using var response = await GetAsync(new Uri(ManagementUrl, $"roots/{index}"), cancellationToken);
        response.EnsureSuccessStatusCode();
        return X509Certificate2.CreateFromPem(await response.Content.ReadAsStringAsync(cancellationToken));
    }

    public async ValueTask InitializeAsync()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        if (!await DockerCli.HasLinuxEngineAsync(cancellationToken))
        {
            SkipReason = "The Pebble tests need a Docker engine for Linux containers.";
            return;
        }

        try
        {
            await StartAsync(cancellationToken);
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            // What Pebble printed is usually the quickest way to see why it did not come up.
            var (_, logs, errors) = await DockerCli.RunAsync(["logs", "--tail", "30", PebbleName], _commandTimeout, CancellationToken.None);
            await DisposeAsync();
            throw new InvalidOperationException($"Pebble did not start. Its log:\n{logs}\n{errors}", error);
        }
    }

    public async ValueTask DisposeAsync()
    {
        GC.SuppressFinalize(this);
        foreach (var container in _containers)
        {
            await DockerCli.RunAsync(["rm", "--force", container], _commandTimeout, CancellationToken.None);
        }

        _containers.Clear();
        if (_networkCreated)
        {
            await DockerCli.RunAsync(["network", "rm", Network], _commandTimeout, CancellationToken.None);
            _networkCreated = false;
        }

        _pebbleHttp?.Dispose();
        _challengeHttp?.Dispose();
        if (Directory.Exists(_workFolder))
        {
            Directory.Delete(_workFolder, recursive: true);
        }
    }

    private static async Task EnsureImageAsync(string image, CancellationToken cancellationToken)
    {
        var (present, _, _) = await DockerCli.RunAsync(["image", "inspect", "--format", "{{.Id}}", image], _commandTimeout, cancellationToken);
        for (var attempt = 1; present != 0; attempt++)
        {
            // Registry pulls fail now and then on a slow network; three tries before giving up.
            var (pulled, _, error) = await DockerCli.RunAsync(["pull", "--quiet", image], _pullTimeout, cancellationToken);
            if (pulled == 0)
            {
                return;
            }

            if (attempt == 3)
            {
                throw new InvalidOperationException($"Pulling {image} failed: {error}");
            }

            await Task.Delay(TimeSpan.FromSeconds(5), cancellationToken);
        }
    }

    private static async Task<int> PublishedPortAsync(string container, int port, CancellationToken cancellationToken)
    {
        var mapping = await DockerCli.RunCheckedAsync(["port", container, $"{port}/tcp"], _commandTimeout, cancellationToken);
        var first = mapping.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)[0];
        return int.Parse(first[(first.LastIndexOf(':') + 1)..], CultureInfo.InvariantCulture);
    }

    /// <summary>
    /// The production handler, plus a certificate check that trusts exactly Pebble's test CA, for
    /// Pebble's API and management ports only. Name checks stay on: the CA's certificate names
    /// 127.0.0.1.
    /// </summary>
    private static SocketsHttpHandler TrustingOnly(X509Certificate2 root)
    {
        var handler = AcmeTransport.CreateHandler();
        handler.SslOptions = new SslClientAuthenticationOptions
        {
            RemoteCertificateValidationCallback = (_, certificate, _, errors) =>
            {
                if (certificate is not X509Certificate2 presented
                    || (errors & ~SslPolicyErrors.RemoteCertificateChainErrors) != SslPolicyErrors.None)
                {
                    return false;
                }

                using var chain = new X509Chain();
                chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
                chain.ChainPolicy.CustomTrustStore.Add(root);
                chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
                return chain.Build(presented);
            },
        };
        return handler;
    }

    private static async Task WaitUntilAsync(Func<Task<bool>> ready, string what, CancellationToken cancellationToken)
    {
        var giveUp = DateTimeOffset.UtcNow.AddSeconds(30);
        HttpRequestException? last = null;
        while (DateTimeOffset.UtcNow < giveUp)
        {
            try
            {
                if (await ready())
                {
                    return;
                }
            }
            catch (HttpRequestException error)
            {
                // Not listening yet, most likely.
                last = error;
            }

            await Task.Delay(TimeSpan.FromMilliseconds(250), cancellationToken);
        }

        throw new TimeoutException($"{what} did not come up within 30 seconds.", last);
    }

    /// <summary>A GET to Pebble, which refuses any request without a User-Agent (RFC 8555 section 6.1).</summary>
    private async Task<HttpResponseMessage> GetAsync(Uri url, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.TryAddWithoutValidation("User-Agent", "runova-core-system-tests");
        return await _pebbleHttp!.SendAsync(request, cancellationToken);
    }

    private async Task StartAsync(CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(_workFolder);
        await EnsureImageAsync(PebbleImage, cancellationToken);
        await EnsureImageAsync(ChallTestServerImage, cancellationToken);
        await DockerCli.RunCheckedAsync(["network", "create", Network], _commandTimeout, cancellationToken);
        _networkCreated = true;

        // challtestsrv: DNS on 8053 and HTTP-01 on 5002 for every name, no AAAA answers (so Pebble
        // never tries IPv6), and the HTTPS and TLS-ALPN servers off.
        _containers.Add(ChallTestServerName);
        await DockerCli.RunCheckedAsync(
            [
                "run", "--detach", "--name", ChallTestServerName, "--network", Network,
                "--publish", $"127.0.0.1::{ChallengeManagementPort}",
                ChallTestServerImage,
                "-defaultIPv6", string.Empty, "-https01", string.Empty, "-tlsalpn01", string.Empty, "-doh", string.Empty,
            ],
            _commandTimeout,
            cancellationToken);
        var challengeAddress = await DockerCli.RunCheckedAsync(
            ["inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", ChallTestServerName],
            _commandTimeout,
            cancellationToken);
        var challengePort = await PublishedPortAsync(ChallTestServerName, ChallengeManagementPort, cancellationToken);
        _challengeHttp = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{challengePort}/") };
        Challenges = new ChallTestServer(_challengeHttp);
        await WaitUntilAsync(
            async () =>
            {
                await Challenges.SetDefaultAddressAsync(challengeAddress, cancellationToken);
                return true;
            },
            "pebble-challtestsrv",
            cancellationToken);

        // Pebble: strict mode, no artificial validation delays, one alternate chain, DNS from
        // challtestsrv. Created first so the configuration can be copied in before it starts.
        _containers.Add(PebbleName);
        await DockerCli.RunCheckedAsync(
            [
                "create", "--name", PebbleName, "--network", Network,
                "--publish", $"127.0.0.1::{AcmePort}", "--publish", $"127.0.0.1::{ManagementPort}",
                "--env", "PEBBLE_VA_NOSLEEP=1", "--env", "PEBBLE_ALTERNATE_ROOTS=1",
                PebbleImage,
                "-config", "/test/config/runova.json", "-strict", "-dnsserver", $"{challengeAddress}:8053",
            ],
            _commandTimeout,
            cancellationToken);
        var configuration = Path.Combine(_workFolder, "runova.json");
        await File.WriteAllTextAsync(configuration, Configuration.Replace("HTTP_PORT", _httpPort.ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal), cancellationToken);
        await DockerCli.RunCheckedAsync(["cp", configuration, $"{PebbleName}:/test/config/runova.json"], _commandTimeout, cancellationToken);
        var minica = Path.Combine(_workFolder, "pebble.minica.pem");
        await DockerCli.RunCheckedAsync(["cp", $"{PebbleName}:/test/certs/pebble.minica.pem", minica], _commandTimeout, cancellationToken);
        await DockerCli.RunCheckedAsync(["start", PebbleName], _commandTimeout, cancellationToken);

        using var testRoot = X509Certificate2.CreateFromPem(await File.ReadAllTextAsync(minica, cancellationToken));
        _pebbleHttp = new HttpClient(TrustingOnly(X509CertificateLoader.LoadCertificate(testRoot.RawData)))
        {
            Timeout = Timeout.InfiniteTimeSpan,
        };
        DirectoryUrl = new Uri($"https://127.0.0.1:{await PublishedPortAsync(PebbleName, AcmePort, cancellationToken)}/dir");
        ManagementUrl = new Uri($"https://127.0.0.1:{await PublishedPortAsync(PebbleName, ManagementPort, cancellationToken)}/");
        await WaitUntilAsync(
            async () =>
            {
                using var response = await GetAsync(DirectoryUrl, cancellationToken);
                return response.IsSuccessStatusCode;
            },
            "Pebble",
            cancellationToken);
    }
}
