using Runova.ServerCore.Contracts;
using Runova.ServerCore.Jobs;
using Runova.ServerCore.Stacks;
using Runova.ServerCore.Web;

namespace Runova.ServerCore.Backups;

/// <summary>
/// What a restore starts again through the core's own operations (E28): a stack is deployed at
/// its live revision, as its own job with its own log, and waited for; the websites are rendered
/// from the restored database and applied the way an edit applies them.
/// </summary>
internal sealed class CoreRestoreTargets(StackOperations stacks, WebSites sites, JobEngine jobs) : IRestoreTargets
{
    private static readonly StackCaller _caller = new(Guid.Empty, "restore");

    public async Task<string?> StartProjectAsync(string project, CancellationToken cancellationToken)
    {
        var stack = (await stacks.ListAsync(cancellationToken)).FirstOrDefault(s => string.Equals(s.Name, project, StringComparison.Ordinal));
        if (stack is null)
        {
            return $"No stack called {project} came back with the backup; it was started outside Runova.";
        }

        if (stack.LiveRevision is not { } revision)
        {
            return $"The stack {project} has no deployed revision to start.";
        }

        var job = await stacks.DeployAsync(stack.Id, revision, _caller, cancellationToken);
        var finished = await jobs.WhenFinishedAsync(job.Id, cancellationToken);
        return finished.State == JobState.Succeeded ? null : $"The deploy job ended {finished.State}: {finished.Error ?? "see its log"}.";
    }

    public async Task<string?> ApplyWebsitesAsync(CancellationToken cancellationToken)
    {
        // A server that had no websites has nothing for nginx to serve, and may not have nginx.
        if ((await sites.ListSitesAsync(cancellationToken)).Length == 0 && (await sites.ListStreamsAsync(cancellationToken)).Length == 0)
        {
            return null;
        }

        var result = await sites.ApplyAsync(new Updates.Requester(Guid.Empty, "restore"), cancellationToken);
        if (result.Applied || (result.Problems.Length == 0 && result.Error is null))
        {
            return null;
        }

        return result.Error ?? string.Join(" ", result.Problems.Select(problem => problem.Message));
    }
}
