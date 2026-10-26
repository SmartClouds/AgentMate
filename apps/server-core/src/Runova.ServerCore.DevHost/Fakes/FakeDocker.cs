using Runova.ServerCore.Contracts;
using Runova.ServerCore.Docker;
using Runova.ServerCore.Jobs;

namespace Runova.ServerCore.DevHost.Fakes;

/// <summary>
/// Docker's packages on the pretend server: already installed, nothing in conflict, and an
/// install that prints what the real job would, a few lines a second.
/// </summary>
internal sealed class FakeDockerSetup(TimeProvider time) : IDockerSetup
{
    private static readonly TimeSpan _line = TimeSpan.FromMilliseconds(250);

    public Task<DockerSetupState> InspectAsync(CancellationToken cancellationToken) =>
        Task.FromResult(new DockerSetupState(Installed: true, [], "2.39.4"));

    public async Task InstallAsync(bool removeConflicting, JobContext job, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(job);
        string[] lines =
        [
            "Downloading Docker's repository key from https://download.docker.com/linux/ubuntu/gpg.",
            $"The key's fingerprint is Docker's: {DockerRepository.DebianFingerprint}.",
            "Added Docker's repository for ubuntu noble (amd64).",
            "Reading package lists...",
            "docker-ce is already the newest version (5:29.1.3-1~ubuntu.24.04~noble).",
            "Starting Docker and enabling it at boot.",
            $"Docker Engine {InMemoryDockerEngine.EngineVersionText} is running (API 1.52).",
            "Docker Compose 2.39.4 is installed.",
        ];
        foreach (var line in lines)
        {
            await Task.Delay(_line, time, cancellationToken);
            job.Log(line, JobLogSource.Out);
        }

        job.ExitCode = 0;
    }
}
