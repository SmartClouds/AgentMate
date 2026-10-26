using System.Globalization;
using System.Text;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Jobs;
using Runova.ServerCore.Platform;

namespace Runova.ServerCore.Nginx;

/// <summary>Where nginx.org's signing key comes from (the internet, or a fixture in tests).</summary>
internal interface INginxSigningKeySource
{
    Task<string> GetAsync(CancellationToken cancellationToken);
}

internal sealed class HttpNginxSigningKeySource : INginxSigningKeySource
{
    private const int MaxBytes = 256 * 1024;

    public async Task<string> GetAsync(CancellationToken cancellationToken)
    {
        using var http = new HttpClient(new SocketsHttpHandler { AllowAutoRedirect = false, ConnectTimeout = TimeSpan.FromSeconds(15) })
        {
            Timeout = TimeSpan.FromSeconds(60),
            MaxResponseContentBufferSize = MaxBytes,
        };
        return await http.GetStringAsync(new Uri(NginxRepository.SigningKeyUrl), cancellationToken);
    }
}

/// <summary>
/// Installs nginx from nginx.org's stable repository, or adopts the one already there, and sets it
/// up for Runova: its folders, a first (empty) release behind the current link, the stock
/// default site backed up and switched off, and the include lines in nginx.conf. Every change to
/// nginx.conf is checked with nginx -t and taken back if nginx refuses it.
/// </summary>
internal sealed class NginxSetup(
    NginxControl control,
    NginxSeLinux seLinux,
    INginxSigningKeySource signingKey,
    OsInfo os,
    TimeProvider time)
{
    private const UnixFileMode Readable = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead | UnixFileMode.OtherRead;
    private const UnixFileMode OpenFolder =
        UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
        | UnixFileMode.GroupRead | UnixFileMode.GroupExecute | UnixFileMode.OtherRead | UnixFileMode.OtherExecute;

    /// <summary>The stock default sites: Debian's distribution package, then nginx.org's.</summary>
    public static readonly IReadOnlyList<string> DefaultSites = ["/etc/nginx/sites-enabled/default", "/etc/nginx/conf.d/default.conf"];

    private static readonly Dictionary<string, string> _aptEnvironment = new(StringComparer.Ordinal)
    {
        ["DEBIAN_FRONTEND"] = "noninteractive",
        ["NEEDRESTART_MODE"] = "a",
        ["APT_LISTCHANGES_FRONTEND"] = "none",
    };

    private static readonly string[] _aptOptions =
    [
        "-q", "-y", "-o", "DPkg::Lock::Timeout=300", "-o", "Dpkg::Options::=--force-confdef", "-o", "Dpkg::Options::=--force-confold",
    ];

    private INginxMachine Machine => control.Machine;

    /// <summary>Installs (or adopts) nginx, then sets it up. The job's log tells each step.</summary>
    public async Task InstallAsync(NginxLayout layout, JobContext job, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(layout);
        ArgumentNullException.ThrowIfNull(job);
        var inspection = await control.InspectAsync(layout, cancellationToken);
        if (inspection.Installed && inspection.Version >= NginxRepository.MinimumVersion)
        {
            job.Log($"nginx {inspection.Version} is already installed{(inspection.FromNginxOrg ? " from nginx.org" : string.Empty)}; adopting it.");
        }
        else
        {
            job.Log(inspection.Installed
                ? $"nginx {inspection.Version} is older than {NginxRepository.MinimumVersion}, which the sites need; upgrading it from nginx.org."
                : "Installing nginx from nginx.org's stable repository.");
            await InstallPackageAsync(job, cancellationToken);
        }

        await SetUpAsync(layout, job, cancellationToken);
    }

    public async Task SetUpAsync(NginxLayout layout, JobContext job, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(layout);
        ArgumentNullException.ThrowIfNull(job);
        var inspection = await control.InspectAsync(layout, cancellationToken);
        if (!inspection.Installed)
        {
            throw new JobFailedException("nginx is not installed, so it cannot be set up.");
        }

        var stamp = time.GetUtcNow().ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture);
        var backup = $"{layout.ConfigRoot}/backup/{stamp}";
        foreach (var folder in new[] { layout.ConfigRoot, layout.ReleasesDirectory, layout.AcmeChallengeDirectory, layout.SitesRoot })
        {
            await Machine.CreateDirectoryAsync(folder, OpenFolder, cancellationToken);
        }

        if (inspection.CurrentRelease is null)
        {
            job.Log("Writing the first release: no sites yet, and a default server that answers nothing.");
            var release = NginxRenderer.Render(NginxConfiguration.Empty, layout, UpstreamPolicy.Default, 1);
            await Machine.CreateDirectoryAsync(release.Directory, OpenFolder, cancellationToken);
            foreach (var file in release.Files)
            {
                await Machine.WriteAsync($"{release.Directory}/{file.Path}", Encoding.UTF8.GetBytes(file.Content), Readable, cancellationToken);
            }

            await Machine.ReplaceLinkAsync(layout.CurrentLink, "releases/1", cancellationToken);
        }

        var disabled = new List<(string Path, string Content)>();
        foreach (var site in DefaultSites)
        {
            if (await Machine.ReadTextAsync(site, cancellationToken) is { } content)
            {
                await Machine.WriteAsync($"{backup}/{Path.GetFileName(site)}", Encoding.UTF8.GetBytes(content), Readable, cancellationToken);
                await Machine.DeleteAsync(site, cancellationToken);
                disabled.Add((site, content));
                job.Log($"Switched off the stock default site {site} (a copy is in {backup}).");
            }
        }

        var original = await Machine.ReadTextAsync(inspection.ConfPath, cancellationToken)
            ?? throw new JobFailedException($"{inspection.ConfPath} is missing.");
        var withStream = inspection.StreamModule != NginxStreamModule.None;
        if (!inspection.HttpWired || (withStream && !inspection.StreamWired))
        {
            await Machine.WriteAsync($"{backup}/nginx.conf", Encoding.UTF8.GetBytes(original), Readable, cancellationToken);
            job.Log($"Adding Runova's include lines to {inspection.ConfPath} (a copy of the original is in {backup}).");
            var wired = await TryWireAsync(inspection.ConfPath, original, layout, withStream, job, cancellationToken)
                || (withStream && await TryWireAsync(inspection.ConfPath, original, layout, stream: false, job, cancellationToken));
            if (!wired)
            {
                await Machine.WriteAsync(inspection.ConfPath, Encoding.UTF8.GetBytes(original), Readable, cancellationToken);
                foreach (var (path, content) in disabled)
                {
                    await Machine.WriteAsync(path, Encoding.UTF8.GetBytes(content), Readable, cancellationToken);
                }

                throw new JobFailedException("nginx refused its configuration with Runova's include lines, so nginx.conf was put back as it was. The log shows nginx's reason.");
            }
        }
        else if (!(await control.TestAsync(cancellationToken)).Succeeded)
        {
            throw new JobFailedException("nginx -t fails on this server's configuration; fix it before Runova takes over.");
        }

        if (inspection.SeLinuxEnabled)
        {
            job.Log("SELinux is on: allowing nginx to reach upstreams and labelling its folders.");
            foreach (var warning in await seLinux.PrepareAsync(layout, cancellationToken))
            {
                job.Log(warning, JobLogSource.Err);
            }
        }

        job.Log("Starting nginx and checking that it runs the new configuration.");
        await Machine.RunAsync(new ProcessSpec { Program = "systemctl", Arguments = ["enable", "nginx.service"], Timeout = TimeSpan.FromMinutes(1) }, cancellationToken);
        var reload = await control.ReloadAsync(await control.InspectAsync(layout, cancellationToken), layout, cancellationToken);
        if (!reload.Confirmed)
        {
            throw new JobFailedException("nginx did not start with its new configuration: " + reload.Error.Trim());
        }

        job.Log("nginx is set up for Runova.");
    }

    private async Task<bool> TryWireAsync(string confPath, string original, NginxLayout layout, bool stream, JobContext job, CancellationToken cancellationToken)
    {
        string wired;
        try
        {
            wired = NginxConfWiring.Wire(original, layout, stream);
        }
        catch (NginxSetupException error)
        {
            throw new JobFailedException(error.Message);
        }

        await Machine.WriteAsync(confPath, Encoding.UTF8.GetBytes(wired), Readable, cancellationToken);
        var test = await control.TestAsync(cancellationToken);
        foreach (var line in (test.StandardError + test.StandardOutput).Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            job.Log(line, test.Succeeded ? JobLogSource.Out : JobLogSource.Err);
        }

        if (!test.Succeeded && stream)
        {
            job.Log("Trying again without the stream block: this nginx may lack its stream module, so TCP and UDP proxies will be off.");
        }

        return test.Succeeded;
    }

    private async Task InstallPackageAsync(JobContext job, CancellationToken cancellationToken)
    {
        job.Log($"Fetching nginx.org's signing key from {NginxRepository.SigningKeyUrl}.");
        string armored;
        try
        {
            armored = await signingKey.GetAsync(cancellationToken);
        }
        catch (Exception error) when (error is HttpRequestException or TaskCanceledException && !cancellationToken.IsCancellationRequested)
        {
            throw new JobFailedException($"Could not download nginx.org's signing key: {error.Message}");
        }

        if (NginxRepository.CheckSigningKey(armored, out var keyring) is { } refusal)
        {
            throw new JobFailedException(refusal);
        }

        job.Log($"The key carries exactly the published fingerprints ({string.Join(", ", NginxRepository.SigningKeyFingerprints)}).");
        switch (os.Family)
        {
            case OsFamily.Debian:
                var release = OsRelease.Parse(await Machine.ReadTextAsync(OsRelease.Path, cancellationToken) ?? string.Empty);
                var codename = release.GetValueOrDefault("VERSION_CODENAME") ?? release.GetValueOrDefault("UBUNTU_CODENAME");
                if (string.IsNullOrWhiteSpace(codename) || !codename.All(char.IsAsciiLetterLower) || os.Id is not ("ubuntu" or "debian"))
                {
                    throw new JobFailedException("This system's release codename is unknown, so nginx.org's repository cannot be chosen for it.");
                }

                await Machine.WriteAsync(NginxRepository.DebianKeyringPath, keyring, Readable, cancellationToken);
                await Machine.WriteAsync(NginxRepository.DebianSourcesPath, Encoding.UTF8.GetBytes(NginxRepository.DebianSources(os.Id, codename)), Readable, cancellationToken);
                await Machine.WriteAsync(NginxRepository.DebianPinPath, Encoding.UTF8.GetBytes(NginxRepository.DebianPin), Readable, cancellationToken);
                await RunPackagesAsync(job, "refresh", "Refresh the package index", "/usr/bin/apt-get", [.. _aptOptions, "update"], TimeSpan.FromMinutes(10), cancellationToken);
                await RunPackagesAsync(job, "install", "Install nginx", "/usr/bin/apt-get", [.. _aptOptions, "install", "nginx"], TimeSpan.FromMinutes(30), cancellationToken);
                break;
            case OsFamily.Rhel:
                var major = int.TryParse(os.VersionId.Split('.')[0], NumberStyles.None, CultureInfo.InvariantCulture, out var number) ? number : 0;
                if (major < 8)
                {
                    throw new JobFailedException("This system's major version is unknown, so nginx.org's repository cannot be chosen for it.");
                }

                // rpm reads the armored key; dnf then checks every package against this copy only.
                await Machine.WriteAsync(NginxRepository.RhelKeyPath, Encoding.ASCII.GetBytes(armored), Readable, cancellationToken);
                await Machine.WriteAsync(NginxRepository.RhelRepoPath, Encoding.UTF8.GetBytes(NginxRepository.RhelRepo(major)), Readable, cancellationToken);
                await RunPackagesAsync(job, "install", "Install nginx", "/usr/bin/dnf", ["-y", "--setopt=install_weak_deps=False", "install", "nginx"], TimeSpan.FromMinutes(30), cancellationToken);
                break;
            default:
                throw new JobFailedException("The core installs nginx on the Debian and RHEL families only.");
        }
    }

    private async Task RunPackagesAsync(
        JobContext job,
        string step,
        string description,
        string program,
        string[] arguments,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        var result = await Machine.RunInUnitAsync(
            job,
            step,
            description,
            new ProcessSpec
            {
                Program = program,
                Arguments = arguments,
                Environment = program.EndsWith("apt-get", StringComparison.Ordinal) ? _aptEnvironment : new Dictionary<string, string>(),
                Timeout = timeout,
                MaxOutputBytes = 256 * 1024,
            },
            cancellationToken);
        job.ExitCode = result.ExitCode;
        if (!result.Succeeded)
        {
            throw new JobFailedException(
                result.TimedOut ? $"{description} did not finish in time and was stopped." : $"{description} failed (exit code {result.ExitCode}). The log shows why.",
                result.ExitCode);
        }
    }
}
