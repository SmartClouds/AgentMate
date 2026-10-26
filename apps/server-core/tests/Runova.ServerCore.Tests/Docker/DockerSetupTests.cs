using Runova.ServerCore.Contracts;
using Runova.ServerCore.Docker;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Jobs;
using Runova.ServerCore.Platform;

namespace Runova.ServerCore.Tests.Docker;

/// <summary>
/// T1: Docker from download.docker.com on both families, as Docker's guides do it, checked
/// command by command: conflicting packages only removed when the request agrees, the key only
/// trusted with the pinned fingerprint, the repository written next to it, packages installed in
/// transient units, the service enabled and started, and both versions reported.
/// </summary>
public sealed class DockerSetupTests
{
    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private static readonly string[] _aptOptions =
    [
        "-q", "-y", "-o", "DPkg::Lock::Timeout=300", "-o", "Dpkg::Options::=--force-confdef", "-o", "Dpkg::Options::=--force-confold",
    ];

    private sealed class Keys(string key) : IRepositoryKeys
    {
        public List<Uri> Fetched { get; } = [];

        public Task<string> FetchAsync(Uri url, CancellationToken cancellationToken)
        {
            Fetched.Add(url);
            return Task.FromResult(key);
        }
    }

    private static string Key(string name) => Fixtures.Read($"docker/keys/{name}.asc");

    private static OsInfo Os(TestRoot root) => OsRelease.Describe(OsRelease.Parse(root.Files.ReadText(OsRelease.Path)!));

    private static FakeProcessRunner Processes(string compose = "2.39.4")
    {
        var processes = new FakeProcessRunner();
        processes.Respond("dpkg", ["--print-architecture"], _ => FakeProcessRunner.Ok("amd64\n"));
        processes.Respond("docker", ["compose", "version", "--short"], _ => FakeProcessRunner.Ok(compose + "\n"));
        return processes;
    }

    private static LinuxDockerSetup Setup(TestRoot root, FakeProcessRunner processes, IRepositoryKeys keys) =>
        new(processes, Units.Runner(processes), root.Files, Os(root), keys, new InMemoryDockerEngine(TimeProvider.System), TimeProvider.System);

    private static TestRoot Ubuntu()
    {
        var root = new TestRoot("ubuntu-24.04");
        root.Write("/etc/apt/keyrings/.keep", string.Empty);
        root.Write("/etc/apt/sources.list.d/.keep", string.Empty);
        return root;
    }

    private static TestRoot Rocky()
    {
        var root = new TestRoot("rocky-9");
        root.Write("/etc/pki/rpm-gpg/.keep", string.Empty);
        root.Write("/etc/yum.repos.d/.keep", string.Empty);
        return root;
    }

    [Fact]
    public async Task On_ubuntu_it_adds_docker_s_signed_repository_installs_the_packages_and_starts_the_engine()
    {
        using var root = Ubuntu();
        var processes = Processes();
        var keys = new Keys(Key("ubuntu"));
        using var job = new TestJob(JobKind.DockerInstall);

        await Setup(root, processes, keys).InstallAsync(removeConflicting: false, job.Context, Cancel);

        Assert.Equal([new Uri("https://download.docker.com/linux/ubuntu/gpg")], keys.Fetched);
        Assert.Equal(Key("ubuntu"), File.ReadAllText(root.Resolve(DockerRepository.AptKeyring)));
        var source = File.ReadAllText(root.Resolve(DockerRepository.AptSource));
        Assert.Contains("URIs: https://download.docker.com/linux/ubuntu\n", source, StringComparison.Ordinal);
        Assert.Contains("Suites: noble\n", source, StringComparison.Ordinal);
        Assert.Contains("Architectures: amd64\n", source, StringComparison.Ordinal);
        Assert.Contains("Signed-By: /etc/apt/keyrings/docker.asc\n", source, StringComparison.Ordinal);
        var units = processes.Calls.Where(Units.IsUnitRun).Select(Units.Command).ToList();
        Assert.Equal(
            [
                ["/usr/bin/apt-get", .. _aptOptions, "update"],
                ["/usr/bin/apt-get", .. _aptOptions, "install", "ca-certificates"],
                ["/usr/bin/apt-get", .. _aptOptions, "update"],
                ["/usr/bin/apt-get", .. _aptOptions, "install", .. DockerRepository.Packages],
            ],
            units);
        Assert.All(processes.Calls.Where(Units.IsUnitRun), unit => Assert.Contains("DEBIAN_FRONTEND=noninteractive", Units.Environment(unit)));
        Assert.Contains(processes.Calls, spec => FakeProcessRunner.Is(spec, "systemctl", "enable", "--now", "containerd.service", "docker.service"));
        var log = (await job.LinesAsync()).Select(line => line.Text).ToList();
        Assert.Contains(log, line => line.Contains(DockerRepository.DebianFingerprint, StringComparison.Ordinal));
        Assert.Contains(log, line => line.Contains($"Docker Engine {InMemoryDockerEngine.EngineVersionText} is running", StringComparison.Ordinal));
        Assert.Contains("Docker Compose 2.39.4 is installed.", log);
    }

    [Fact]
    public async Task On_rocky_podman_and_runc_stay_unless_the_request_agrees_to_their_removal()
    {
        using var root = Rocky();
        var processes = Processes();
        processes.Respond("rpm", ["-q", "--qf"], _ => FakeProcessRunner.Exit(9, "package docker is not installed\npodman\npackage buildah is not installed\nrunc\n"));
        var keys = new Keys(Key("rhel"));
        using var job = new TestJob(JobKind.DockerInstall);

        var refusal = await Assert.ThrowsAsync<JobFailedException>(() => Setup(root, processes, keys).InstallAsync(removeConflicting: false, job.Context, Cancel));
        var state = await Setup(root, processes, keys).InspectAsync(Cancel);

        Assert.Contains("podman, runc", refusal.Message, StringComparison.Ordinal);
        Assert.Equal(["podman", "runc"], state.ConflictingPackages);
        Assert.Empty(keys.Fetched);
        Assert.DoesNotContain(processes.Calls, Units.IsUnitRun);
        Assert.False(File.Exists(root.Resolve(DockerRepository.RpmRepository)));
    }

    [Fact]
    public async Task On_rocky_with_agreement_it_removes_the_conflicts_then_installs_from_docker_s_repository()
    {
        using var root = Rocky();
        var processes = Processes();
        processes.Respond("rpm", ["-q", "--qf"], _ => FakeProcessRunner.Exit(9, "podman\nbuildah\nrunc\n"));
        var keys = new Keys(Key("rhel"));
        using var job = new TestJob(JobKind.DockerInstall);

        await Setup(root, processes, keys).InstallAsync(removeConflicting: true, job.Context, Cancel);

        Assert.Equal([new Uri("https://download.docker.com/linux/centos/gpg")], keys.Fetched);
        var units = processes.Calls.Where(Units.IsUnitRun).Select(Units.Command).ToList();
        Assert.Equal(
            [
                ["/usr/bin/dnf", "-y", "remove", "podman", "buildah", "runc"],
                ["/usr/bin/dnf", "-y", "install", .. DockerRepository.Packages],
            ],
            units);
        var repository = File.ReadAllText(root.Resolve(DockerRepository.RpmRepository));
        Assert.Contains("baseurl=https://download.docker.com/linux/centos/$releasever/$basearch/stable\n", repository, StringComparison.Ordinal);
        Assert.Contains("gpgcheck=1\n", repository, StringComparison.Ordinal);
        Assert.Contains("gpgkey=file:///etc/pki/rpm-gpg/docker-ce.asc\n", repository, StringComparison.Ordinal);
        Assert.Equal(Key("rhel"), File.ReadAllText(root.Resolve(DockerRepository.RpmKey)));
        // The conflicts go only after the key proved to be Docker's.
        Assert.Contains(await job.LinesAsync(), line => line.Text.Contains(DockerRepository.RhelFingerprint, StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_key_that_is_not_docker_s_stops_the_job_before_anything_changes()
    {
        using var root = Ubuntu();
        var processes = Processes();
        processes.Respond("dpkg-query", ["-W"], _ => FakeProcessRunner.Exit(1, "docker.io install ok installed\n"));
        using var job = new TestJob(JobKind.DockerInstall);

        var refusal = await Assert.ThrowsAsync<JobFailedException>(() =>
            Setup(root, processes, new Keys(Key("rhel"))).InstallAsync(removeConflicting: true, job.Context, Cancel));

        Assert.Contains("is not Docker's", refusal.Message, StringComparison.Ordinal);
        Assert.Contains(DockerRepository.RhelFingerprint, refusal.Message, StringComparison.Ordinal);
        Assert.DoesNotContain(processes.Calls, Units.IsUnitRun);
        Assert.False(File.Exists(root.Resolve(DockerRepository.AptKeyring)));
    }

    [Fact]
    public async Task A_compose_older_than_2_24_4_fails_the_install()
    {
        using var root = Ubuntu();
        using var job = new TestJob(JobKind.DockerInstall);

        var refusal = await Assert.ThrowsAsync<JobFailedException>(() =>
            Setup(root, Processes(compose: "2.20.2"), new Keys(Key("ubuntu"))).InstallAsync(removeConflicting: false, job.Context, Cancel));

        Assert.Contains("2.20.2", refusal.Message, StringComparison.Ordinal);
        Assert.Contains("2.24.4", refusal.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Inspecting_reads_what_is_installed_and_what_conflicts()
    {
        using var root = Ubuntu();
        root.Write(LinuxDockerSetup.Dockerd, "#!/bin/sh");
        var processes = Processes(compose: "v2.39.4");
        processes.Respond("dpkg-query", ["-W"], _ => FakeProcessRunner.Exit(1, "docker.io install ok installed\ncontainerd deinstall ok config-files\n"));

        var state = await Setup(root, processes, new Keys(string.Empty)).InspectAsync(Cancel);

        Assert.True(state.Installed);
        Assert.Equal(["docker.io"], state.ConflictingPackages);
        Assert.Equal("2.39.4", state.ComposeVersion);
    }

    [Theory]
    [InlineData("2.39.4", true)]
    [InlineData("v2.24.4", true)]
    [InlineData("2.24.4-desktop.1", true)]
    [InlineData("2.24.3", false)]
    [InlineData("garbage", false)]
    public void Compose_versions_compare_against_the_minimum(string text, bool enough)
    {
        var version = DockerRepository.ParseComposeVersion(text);

        Assert.Equal(enough, version is not null && version >= DockerRepository.MinimumCompose);
    }
}
