using Runova.ServerCore.Contracts;
using Runova.ServerCore.Docker;
using Runova.ServerCore.Jobs;

namespace Runova.ServerCore.Tests.Docker;

/// <summary>Docker's packages, pretended: installing only records that it was asked for.</summary>
internal sealed class FakeDockerSetup(MutationLog mutations) : IDockerSetup
{
    public DockerSetupState State { get; set; } = new(Installed: true, [], "2.39.4");

    public Task<DockerSetupState> InspectAsync(CancellationToken cancellationToken) => Task.FromResult(State);

    public Task InstallAsync(bool removeConflicting, JobContext job, CancellationToken cancellationToken)
    {
        mutations.Add($"docker.install removeConflicting={removeConflicting}");
        job.Log("Docker Engine 29.1.3 is running (API 1.52).", JobLogSource.System);
        return Task.CompletedTask;
    }
}
