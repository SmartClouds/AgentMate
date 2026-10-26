using Runova.ServerCore.Contracts;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Jobs;
using Runova.ServerCore.Platform;

namespace Runova.ServerCore.Docker;

/// <summary>What the machine has of Docker, apart from what the engine itself says.</summary>
internal sealed record DockerSetupState(bool Installed, IReadOnlyList<string> ConflictingPackages, string? ComposeVersion);

/// <summary>Docker's packages on the server: looking at them, and installing them as a job.</summary>
internal interface IDockerSetup
{
    Task<DockerSetupState> InspectAsync(CancellationToken cancellationToken);

    /// <summary>
    /// Docker Engine and Compose from download.docker.com. Conflicting packages are removed only
    /// when <paramref name="removeConflicting"/> says so; otherwise their presence fails the job.
    /// </summary>
    Task InstallAsync(bool removeConflicting, JobContext job, CancellationToken cancellationToken);
}

/// <summary>Downloads a repository's signing key; small, over HTTPS, with a time limit.</summary>
internal interface IRepositoryKeys
{
    Task<string> FetchAsync(Uri url, CancellationToken cancellationToken);
}

internal sealed class HttpRepositoryKeys : IRepositoryKeys, IDisposable
{
    private const int MaxKeyBytes = 64 * 1024;

    private readonly HttpClient _client = new(new SocketsHttpHandler { AllowAutoRedirect = false })
    {
        Timeout = TimeSpan.FromMinutes(1),
        MaxResponseContentBufferSize = MaxKeyBytes,
    };

    public async Task<string> FetchAsync(Uri url, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(url);
        if (url.Scheme != Uri.UriSchemeHttps)
        {
            throw new ArgumentException("Repository keys come over HTTPS only.", nameof(url));
        }

        return await _client.GetStringAsync(url, cancellationToken);
    }

    public void Dispose() => _client.Dispose();
}

/// <summary>
/// Installs Docker the way Docker's own guides do, as a job: conflicting packages out (after the
/// person agreed), the repository key downloaded and checked against its pinned fingerprint, the
/// repository written next to it, the packages installed in transient units, the service enabled
/// and started, then the engine and compose versions reported. Compose must be 2.24.4 or later.
/// </summary>
internal sealed class LinuxDockerSetup(
    IProcessRunner runner,
    SystemdRunner units,
    ISystemFiles files,
    OsInfo os,
    IRepositoryKeys keys,
    IDockerEngine engine,
    TimeProvider time) : IDockerSetup
{
    public const string Dockerd = "/usr/bin/dockerd";

    private const string AptGet = "/usr/bin/apt-get";

    private const string Dnf = "/usr/bin/dnf";

    private const UnixFileMode Readable =
        UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead | UnixFileMode.OtherRead;

    private static readonly TimeSpan _engineWait = TimeSpan.FromSeconds(90);

    private static readonly string[] _aptOptions =
    [
        "-q", "-y", "-o", "DPkg::Lock::Timeout=300", "-o", "Dpkg::Options::=--force-confdef", "-o", "Dpkg::Options::=--force-confold",
    ];

    // The same noninteractive settings as the package manager's (AptPackageManager).
    private static readonly Dictionary<string, string> _aptEnvironment = new(StringComparer.Ordinal)
    {
        ["DEBIAN_FRONTEND"] = "noninteractive",
        ["NEEDRESTART_MODE"] = "a",
        ["APT_LISTCHANGES_FRONTEND"] = "none",
        ["UCF_FORCE_CONFFOLD"] = "1",
    };

    public async Task<DockerSetupState> InspectAsync(CancellationToken cancellationToken)
    {
        var installed = files.Exists(Dockerd);
        var conflicts = await ConflictsAsync(cancellationToken);
        string? compose = null;
        if (installed)
        {
            var version = await runner.RunAsync(
                new ProcessSpec { Program = "docker", Arguments = ["compose", "version", "--short"], Timeout = TimeSpan.FromSeconds(30) },
                onLine: null,
                cancellationToken);
            compose = version.Succeeded && version.StandardOutput.Trim() is { Length: > 0 } text ? text.TrimStart('v') : null;
        }

        return new DockerSetupState(installed, conflicts, compose);
    }

    public async Task InstallAsync(bool removeConflicting, JobContext job, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(job);
        if (os.Family is not (OsFamily.Debian or OsFamily.Rhel))
        {
            throw new JobFailedException("Docker can be installed on Ubuntu, Debian and the RHEL family (RHEL, Rocky, Alma, CentOS Stream).");
        }

        var conflicts = await ConflictsAsync(cancellationToken);
        if (conflicts.Count > 0 && !removeConflicting)
        {
            throw new JobFailedException(
                $"These packages conflict with Docker's: {string.Join(", ", conflicts)}. Agree to their removal to go on.");
        }

        job.Log($"Downloading Docker's repository key from {DockerRepository.KeyUrl(os)}.");
        var key = await keys.FetchAsync(DockerRepository.KeyUrl(os), cancellationToken);
        var pinned = DockerRepository.Fingerprint(os.Family);
        if (!OpenPgpKey.HasOnly(key, pinned))
        {
            var found = OpenPgpKey.PrimaryFingerprints(key);
            throw new JobFailedException(
                $"The downloaded key is not Docker's: expected fingerprint {pinned}, got {(found.Count == 0 ? "no key" : string.Join(", ", found))}. Nothing was changed.");
        }

        job.Log($"The key's fingerprint is Docker's: {pinned}.");
        if (conflicts.Count > 0)
        {
            job.Log($"Removing conflicting packages: {string.Join(", ", conflicts)}.");
            await (os.Family == OsFamily.Debian
                ? AptAsync(job, "conflicts", "Remove packages that conflict with Docker", ["remove", .. conflicts], TimeSpan.FromMinutes(20), cancellationToken)
                : DnfAsync(job, "conflicts", "Remove packages that conflict with Docker", ["-y", "remove", .. conflicts], TimeSpan.FromMinutes(20), cancellationToken));
        }

        if (os.Family == OsFamily.Debian)
        {
            await InstallWithAptAsync(key, job, cancellationToken);
        }
        else
        {
            await InstallWithDnfAsync(key, job, cancellationToken);
        }

        job.Log("Starting Docker and enabling it at boot.");
        var start = await runner.RunAsync(
            new ProcessSpec { Program = "systemctl", Arguments = ["enable", "--now", "containerd.service", "docker.service"], Timeout = TimeSpan.FromMinutes(3) },
            job.Output,
            cancellationToken);
        if (!start.Succeeded)
        {
            throw new JobFailedException($"Docker was installed but did not start: {start.StandardError.Trim()}", start.ExitCode);
        }

        await ReportAsync(job, cancellationToken);
    }

    private async Task InstallWithAptAsync(string key, JobContext job, CancellationToken cancellationToken)
    {
        var release = OsRelease.Parse(files.ReadText(OsRelease.Path) ?? files.ReadText(OsRelease.FallbackPath) ?? string.Empty);
        var codename = release.GetValueOrDefault("UBUNTU_CODENAME") is { Length: > 0 } ubuntu ? ubuntu : release.GetValueOrDefault("VERSION_CODENAME");
        if (string.IsNullOrEmpty(codename) || !codename.All(c => char.IsAsciiLetterLower(c) || char.IsAsciiDigit(c)))
        {
            throw new JobFailedException("This system's release has no codename, so Docker's repository cannot be picked.");
        }

        var architecture = (await PlainAsync("dpkg", ["--print-architecture"], cancellationToken)).StandardOutput.Trim();
        if (architecture is not ("amd64" or "arm64"))
        {
            throw new JobFailedException($"Docker is installed on amd64 and arm64 servers; this one is {architecture}.");
        }

        job.Log("Installing what the repository needs (ca-certificates).");
        await AptAsync(job, "refresh", "Refresh the package index", ["update"], TimeSpan.FromMinutes(10), cancellationToken);
        await AptAsync(job, "prereqs", "Install ca-certificates", ["install", "ca-certificates"], TimeSpan.FromMinutes(10), cancellationToken);
        var keyrings = await PlainAsync("install", ["-m", "0755", "-d", "/etc/apt/keyrings"], cancellationToken);
        if (!keyrings.Succeeded)
        {
            throw new JobFailedException($"Could not create /etc/apt/keyrings: {keyrings.StandardError.Trim()}");
        }

        files.WriteText(DockerRepository.AptKeyring, key, Readable);
        files.WriteText(DockerRepository.AptSource, DockerRepository.AptSourceFor(os, codename, architecture), Readable);
        job.Log($"Added Docker's repository for {DockerRepository.Distribution(os)} {codename} ({architecture}).");
        await AptAsync(job, "index", "Refresh the package index", ["update"], TimeSpan.FromMinutes(10), cancellationToken);
        job.Log($"Installing {string.Join(", ", DockerRepository.Packages)}.");
        await AptAsync(job, "install", "Install Docker", ["install", .. DockerRepository.Packages], TimeSpan.FromMinutes(30), cancellationToken);
    }

    private async Task InstallWithDnfAsync(string key, JobContext job, CancellationToken cancellationToken)
    {
        files.WriteText(DockerRepository.RpmKey, key, Readable);
        files.WriteText(DockerRepository.RpmRepository, DockerRepository.RpmRepositoryFor(os), Readable);
        job.Log($"Added Docker's repository for {DockerRepository.Distribution(os)}.");
        job.Log($"Installing {string.Join(", ", DockerRepository.Packages)}.");
        await DnfAsync(job, "install", "Install Docker", ["-y", "install", .. DockerRepository.Packages], TimeSpan.FromMinutes(30), cancellationToken);
    }

    /// <summary>The engine answers once its socket is up; then both versions go in the log.</summary>
    private async Task ReportAsync(JobContext job, CancellationToken cancellationToken)
    {
        var deadline = time.GetUtcNow() + _engineWait;
        EngineVersion? version;
        while ((version = await engine.GetVersionAsync(cancellationToken)) is null)
        {
            if (time.GetUtcNow() > deadline)
            {
                throw new JobFailedException("Docker was installed and started, but its engine did not answer within 90 seconds.");
            }

            await Task.Delay(TimeSpan.FromSeconds(1), time, cancellationToken);
        }

        job.Log($"Docker Engine {version.Version} is running (API {version.ApiVersion}).");
        var compose = await PlainAsync("docker", ["compose", "version", "--short"], cancellationToken);
        var composeVersion = DockerRepository.ParseComposeVersion(compose.StandardOutput);
        if (composeVersion is null || composeVersion < DockerRepository.MinimumCompose)
        {
            throw new JobFailedException(
                $"Docker Compose {(composeVersion?.ToString() ?? "is missing")}: the core needs {DockerRepository.MinimumCompose} or later.");
        }

        job.Log($"Docker Compose {composeVersion} is installed.");
        job.ExitCode = 0;
    }

    private async Task<IReadOnlyList<string>> ConflictsAsync(CancellationToken cancellationToken)
    {
        var candidates = DockerRepository.ConflictingPackages(os.Family);
        if (candidates.Count == 0)
        {
            return [];
        }

        if (os.Family == OsFamily.Debian)
        {
            var query = await PlainAsync("dpkg-query", ["-W", "--showformat=${Package} ${Status}\\n", .. candidates], cancellationToken);
            return [.. query.StandardOutput.Split('\n', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
                .Where(line => line.EndsWith(" install ok installed", StringComparison.Ordinal))
                .Select(line => line.Split(' ')[0])
                .Where(candidates.Contains)
                .Distinct(StringComparer.Ordinal)];
        }

        var rpm = await PlainAsync("rpm", ["-q", "--qf", "%{NAME}\\n", .. candidates], cancellationToken);
        return [.. rpm.StandardOutput.Split('\n', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .Where(candidates.Contains)
            .Distinct(StringComparer.Ordinal)];
    }

    private Task<ProcessResult> PlainAsync(string program, string[] arguments, CancellationToken cancellationToken) =>
        runner.RunAsync(new ProcessSpec { Program = program, Arguments = arguments, Timeout = TimeSpan.FromMinutes(1) }, onLine: null, cancellationToken);

    private Task AptAsync(JobContext job, string step, string description, string[] arguments, TimeSpan timeout, CancellationToken cancellationToken) =>
        UnitAsync(job, step, description, new ProcessSpec { Program = AptGet, Arguments = [.. _aptOptions, .. arguments], Environment = _aptEnvironment, Timeout = timeout, MaxOutputBytes = 256 * 1024 }, cancellationToken);

    private Task DnfAsync(JobContext job, string step, string description, string[] arguments, TimeSpan timeout, CancellationToken cancellationToken) =>
        UnitAsync(job, step, description, new ProcessSpec { Program = Dnf, Arguments = arguments, Timeout = timeout, MaxOutputBytes = 256 * 1024 }, cancellationToken);

    private async Task UnitAsync(JobContext job, string step, string description, ProcessSpec command, CancellationToken cancellationToken)
    {
        var result = await units.RunAsync(job.UnitFor(step), description, command, job.Output, cancellationToken);
        job.ExitCode = result.ExitCode;
        var program = Path.GetFileName(command.Program);
        if (result.TimedOut)
        {
            throw new JobFailedException($"{program} did not finish within {command.Timeout.TotalMinutes:0} minutes and was stopped.");
        }

        if (!result.Succeeded)
        {
            throw new JobFailedException($"{program} exited with code {result.ExitCode}. The log shows why.", result.ExitCode);
        }
    }
}
