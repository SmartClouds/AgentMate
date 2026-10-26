using System.Formats.Tar;
using System.Globalization;
using System.Text;
using Runova.ServerCore.Nginx;
using Runova.ServerCore.Tests.Nginx;

namespace Runova.ServerCore.SystemTests.Nginx;

/// <summary>What curl got back: the final response's status and headers, the body, and curl's own exit code.</summary>
internal sealed record CurlResponse(int ExitCode, int Status, IReadOnlyDictionary<string, string> Headers, string Body, string Error)
{
    public string Header(string name) => Headers.TryGetValue(name, out var value) ? value : string.Empty;

    public string Describe() => $"curl exit {ExitCode}, status {Status}\n{string.Join('\n', Headers.Select(h => $"{h.Key}: {h.Value}"))}\n\n{Body}\n{Error}";

    /// <summary>Reads curl's <c>-D -</c> output: header blocks (a 100 Continue may come first), then the body.</summary>
    public static CurlResponse Parse(DockerResult result)
    {
        var text = result.Output;
        var status = 0;
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        while (text.StartsWith("HTTP/", StringComparison.Ordinal))
        {
            var end = text.IndexOf("\r\n\r\n", StringComparison.Ordinal);
            var block = end < 0 ? text : text[..end];
            text = end < 0 ? string.Empty : text[(end + 4)..];
            var lines = block.Split("\r\n");
            status = int.Parse(lines[0].Split(' ')[1], CultureInfo.InvariantCulture);
            headers.Clear();
            foreach (var line in lines.Skip(1))
            {
                var colon = line.IndexOf(':', StringComparison.Ordinal);
                if (colon > 0)
                {
                    headers[line[..colon]] = line[(colon + 1)..].Trim();
                }
            }
        }

        return new CurlResponse(result.ExitCode, status, headers, text, result.Error);
    }
}

/// <summary>
/// One nginx.org nginx in a container, wired the way the core will wire it, with two stand-in
/// apps: one sharing nginx's network namespace on 127.0.0.1 (where stack services are published)
/// and one elsewhere on a Docker network as <see cref="NginxVariants.RemoteHost"/> (for URL
/// upstreams). Releases are written into numbered directories and switched to by swapping the
/// <c>current</c> symlink, as on a real server.
/// </summary>
internal sealed class NginxHarness : IAsyncDisposable
{
    public const string AcmeToken = "harness-token";
    public const string AcmeContent = "harness-token.key-authorization";
    public const string StaticContent = "hello from the site folder";
    public const string AuthorityPath = "/etc/runova-test/ca.pem";

    private static readonly TimeSpan _buildTimeout = TimeSpan.FromMinutes(25);
    private static readonly TimeSpan _commandTimeout = TimeSpan.FromMinutes(2);

    private readonly string _name;
    private int _release;

    private NginxHarness(string distro, NginxLayout layout, HarnessCertificates certificates)
    {
        Distro = distro;
        Layout = layout;
        Certificates = certificates;
        _name = $"runova-nginx-{distro}-{Guid.NewGuid():N}"[..40];
    }

    public string Distro { get; }

    /// <summary>The distribution's layout, listening on IPv6 only where the container has it.</summary>
    public NginxLayout Layout { get; private set; }

    public HarnessCertificates Certificates { get; }

    public string NginxVersion { get; private set; } = string.Empty;

    /// <summary>The nginx container, for tests that drive it through the core's own code.</summary>
    public string Nginx => _name + "-nginx";

    private string App => _name + "-app";

    private string Backend => _name + "-backend";

    private string Network => _name + "-net";

    public static async Task<NginxHarness> StartAsync(string distro, CancellationToken cancellationToken)
    {
        var testServers = TestServersFolder();
        await DockerCli.CheckedAsync(["build", "-q", "-t", "runova-nginx-upstream:harness", Path.Combine(testServers, "nginx-upstream")], _buildTimeout, cancellationToken);
        await DockerCli.CheckedAsync(["build", "-q", "-t", $"runova-nginx-harness:{distro}", Path.Combine(testServers, $"nginx-{distro}")], _buildTimeout, cancellationToken);

        var siteNames = NginxVariants.All().Sites.Where(s => s.Certificate is not null).SelectMany(s => s.Domains).ToList();
        var layout = distro.StartsWith("rocky", StringComparison.Ordinal) ? NginxLayout.Rhel : NginxLayout.Debian;
        var harness = new NginxHarness(distro, layout, HarnessCertificates.Create(siteNames, NginxVariants.RemoteHost));
        try
        {
            await harness.StartContainersAsync(cancellationToken);
            return harness;
        }
        catch
        {
            await harness.DisposeAsync();
            throw;
        }
    }

    /// <summary>Writes the release into its numbered directory and points <c>current</c> at it.</summary>
    public async Task<NginxRelease> InstallAsync(NginxConfiguration configuration, CancellationToken cancellationToken, NginxLayout? layout = null)
    {
        var number = Interlocked.Increment(ref _release);
        var release = NginxRenderer.Render(configuration, layout ?? Layout, UpstreamPolicy.Default, number);
        var prefix = number.ToString(CultureInfo.InvariantCulture) + "/";
        await CopyAsync(Layout.ReleasesDirectory, release.Files.Select(f => (prefix + f.Path, f.Content)), cancellationToken);
        await ShellAsync(
            "ln -sfn \"releases/$1\" /etc/nginx/runova/current.next && mv -T /etc/nginx/runova/current.next /etc/nginx/runova/current",
            cancellationToken,
            number.ToString(CultureInfo.InvariantCulture));
        return release;
    }

    public Task<string> CurrentTargetAsync(CancellationToken cancellationToken) =>
        DockerCli.CheckedAsync(["exec", Nginx, "readlink", "/etc/nginx/runova/current"], _commandTimeout, cancellationToken);

    public Task<DockerResult> TestConfigurationAsync(CancellationToken cancellationToken) =>
        DockerCli.RunAsync(["exec", Nginx, "nginx", "-t"], _commandTimeout, cancellationToken);

    /// <summary>
    /// Reloads nginx and waits until the new configuration answers. <c>nginx -s reload</c> only
    /// signals the master and returns at once, so its exit code says nothing about the result.
    /// </summary>
    public async Task ReloadAsync(Func<Task<bool>> answersWithNewConfiguration, CancellationToken cancellationToken)
    {
        await DockerCli.CheckedAsync(["exec", Nginx, "nginx", "-s", "reload"], _commandTimeout, cancellationToken);
        var deadline = DateTime.UtcNow.AddSeconds(20);
        while (!await answersWithNewConfiguration())
        {
            if (DateTime.UtcNow > deadline)
            {
                var log = await ShellAsync("tail -n 30 /var/log/nginx/error.log", cancellationToken);
                Assert.Fail($"nginx did not switch to the new configuration on {Distro}. error.log:\n{log.Output}");
            }

            await Task.Delay(200, cancellationToken);
        }
    }

    /// <summary>curl from inside the nginx container, so requests come from 127.0.0.1.</summary>
    public async Task<CurlResponse> CurlAsync(CancellationToken cancellationToken, params string[] arguments) =>
        CurlResponse.Parse(await DockerCli.RunAsync(
            ["exec", Nginx, "curl", "-sS", "-m", "10", "-D", "-", .. arguments],
            _commandTimeout,
            cancellationToken));

    /// <summary>curl from inside the nginx container with its output as it is, for -w or streamed answers.</summary>
    public Task<DockerResult> CurlRawAsync(CancellationToken cancellationToken, params string[] arguments) =>
        DockerCli.RunAsync(["exec", Nginx, "curl", "-sS", "-m", "5", .. arguments], _commandTimeout, cancellationToken);

    public Task<DockerResult> ShellAsync(string script, CancellationToken cancellationToken, params string[] arguments) =>
        DockerCli.RunAsync(["exec", Nginx, "sh", "-c", script, "sh", .. arguments], _commandTimeout, cancellationToken);

    public async ValueTask DisposeAsync()
    {
        foreach (var container in new[] { App, Backend, Nginx })
        {
            await DockerCli.RunAsync(["rm", "-f", container], _commandTimeout, CancellationToken.None);
        }

        await DockerCli.RunAsync(["network", "rm", Network], _commandTimeout, CancellationToken.None);
    }

    private static string TestServersFolder()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            if (File.Exists(Path.Combine(directory.FullName, "Runova.ServerCore.slnx")))
            {
                return Path.Combine(directory.FullName, "test-servers");
            }
        }

        throw new InvalidOperationException("The server core folder was not found above " + AppContext.BaseDirectory);
    }

    private async Task StartContainersAsync(CancellationToken cancellationToken)
    {
        await DockerCli.CheckedAsync(["network", "create", Network], _commandTimeout, cancellationToken);
        await DockerCli.CheckedAsync(["run", "-d", "--name", Nginx, "--network", Network, $"runova-nginx-harness:{Distro}"], _commandTimeout, cancellationToken);
        await DockerCli.CheckedAsync(
            [
                "run", "-d", "--name", App, "--network", $"container:{Nginx}",
                "-e", "LISTEN_HOST=127.0.0.1",
                "-e", $"HTTP_PORT={NginxVariants.UpstreamPort}",
                "-e", $"UDP_PORT={NginxVariants.UdpUpstreamPort}",
                "runova-nginx-upstream:harness",
            ],
            _commandTimeout,
            cancellationToken);
        await DockerCli.CheckedAsync(
            [
                "run", "-d", "--name", Backend, "--network", Network, "--network-alias", NginxVariants.RemoteHost,
                "-e", "LISTEN_HOST=0.0.0.0",
                "-e", $"HTTP_PORT={NginxVariants.RemoteHttpPort}",
                "-e", $"HTTPS_PORT={NginxVariants.RemoteHttpsPort}",
                "-e", "TLS_CERT_B64=" + Convert.ToBase64String(Encoding.ASCII.GetBytes(Certificates.BackendCertificatePem)),
                "-e", "TLS_KEY_B64=" + Convert.ToBase64String(Encoding.ASCII.GetBytes(Certificates.BackendKeyPem)),
                "runova-nginx-upstream:harness",
            ],
            _commandTimeout,
            cancellationToken);

        NginxVersion = (await DockerCli.CheckedAsync(["exec", Nginx, "sh", "-c", "nginx -v 2>&1"], _commandTimeout, cancellationToken)).Trim();

        // The certificates the TLS variants name, and the test CA in the system bundle, which is
        // what https:// upstreams are verified against.
        await CopyAsync(
            "/etc",
            [
                ("runova-test/ca.pem", Certificates.AuthorityPem),
                (NginxVariants.CertificatePath["/etc/".Length..], Certificates.SitesCertificatePem),
                (NginxVariants.KeyPath["/etc/".Length..], Certificates.SitesKeyPem),
            ],
            cancellationToken);
        var trust = Distro.StartsWith("rocky", StringComparison.Ordinal)
            ? $"cp {AuthorityPath} /etc/pki/ca-trust/source/anchors/runova-harness.pem && update-ca-trust"
            : $"cp {AuthorityPath} /usr/local/share/ca-certificates/runova-harness.crt && update-ca-certificates";
        Assert.True((await ShellAsync(trust, cancellationToken)).Succeeded, "The test CA could not be added to the system bundle.");

        // A challenge file for the ACME location, and a file in the snippets variant's site folder.
        await CopyAsync(
            "/var/www/runova",
            [
                ($"acme/.well-known/acme-challenge/{AcmeToken}", AcmeContent),
                ("sites/snippets/static/hello.txt", StaticContent),
            ],
            cancellationToken);

        var ipv6 = await ShellAsync("grep -q '^00000000000000000000000000000001 ' /proc/net/if_inet6", cancellationToken);
        Layout = Layout with { ListenIPv6 = ipv6.Succeeded };

        await WaitForAsync($"http://127.0.0.1:{NginxVariants.UpstreamPort}/", cancellationToken);
        await WaitForAsync($"http://{NginxVariants.RemoteHost}:{NginxVariants.RemoteHttpPort}/", cancellationToken);
    }

    private async Task WaitForAsync(string url, CancellationToken cancellationToken)
    {
        var deadline = DateTime.UtcNow.AddSeconds(30);
        while (true)
        {
            var probe = await ShellAsync("curl -s -o /dev/null -w '%{http_code}' \"$1\"", cancellationToken, url);
            if (probe.Output == "200")
            {
                return;
            }

            if (DateTime.UtcNow > deadline)
            {
                var logs = await DockerCli.RunAsync(["logs", url.Contains(NginxVariants.RemoteHost, StringComparison.Ordinal) ? Backend : App], _commandTimeout, cancellationToken);
                Assert.Fail($"The stand-in app at {url} never answered on {Distro}: {logs.Describe()}");
            }

            await Task.Delay(250, cancellationToken);
        }
    }

    /// <summary>
    /// Copies files into the nginx container under an existing directory, as a tar stream through
    /// <c>docker cp -</c>, so the container needs no tar of its own. Missing folders are created.
    /// </summary>
    private async Task CopyAsync(string destination, IEnumerable<(string Path, string Content)> files, CancellationToken cancellationToken)
    {
        using var archive = new MemoryStream();
        using (var writer = new TarWriter(archive, TarEntryFormat.Pax, leaveOpen: true))
        {
            var folders = new HashSet<string>(StringComparer.Ordinal);
            foreach (var (path, content) in files)
            {
                var parts = path.Split('/');
                for (var depth = 1; depth < parts.Length; depth++)
                {
                    var folder = string.Join('/', parts[..depth]) + "/";
                    if (folders.Add(folder))
                    {
                        writer.WriteEntry(new PaxTarEntry(TarEntryType.Directory, folder)
                        {
                            Mode = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
                                | UnixFileMode.GroupRead | UnixFileMode.GroupExecute | UnixFileMode.OtherRead | UnixFileMode.OtherExecute,
                        });
                    }
                }

                writer.WriteEntry(new PaxTarEntry(TarEntryType.RegularFile, path)
                {
                    Mode = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead | UnixFileMode.OtherRead,
                    DataStream = new MemoryStream(new UTF8Encoding(false).GetBytes(content)),
                });
            }
        }

        await DockerCli.CheckedAsync(["cp", "-", $"{Nginx}:{destination}"], _commandTimeout, cancellationToken, archive.ToArray());
    }
}
