using System.Globalization;
using Microsoft.EntityFrameworkCore;
using Runova.ServerCore.Audit;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Docker;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Jobs;
using Runova.ServerCore.Registries;

namespace Runova.ServerCore.Stacks;

/// <summary>
/// The jobs: a deploy (validate, pull, build, up --wait, health) with its steps recorded on the
/// revision, a rollback that copies an earlier revision into a new one and deploys it, the
/// lifecycle, and deleting. All of them hold the stack's lock, so they never overlap, and their
/// logs mask the stack's env values.
/// </summary>
internal sealed partial class StackOperations
{
    public static readonly TimeSpan PullTimeout = TimeSpan.FromMinutes(30);

    public static readonly TimeSpan BuildTimeout = TimeSpan.FromMinutes(60);

    public static readonly TimeSpan UpTimeout = TimeSpan.FromMinutes(10);

    public static readonly TimeSpan ActionTimeout = TimeSpan.FromMinutes(5);

    /// <summary>How long the health step waits for every container to run, past up --wait.</summary>
    public TimeSpan HealthWait { get; init; } = TimeSpan.FromSeconds(30);

    public TimeSpan HealthPoll { get; init; } = TimeSpan.FromSeconds(1);

    private static readonly StackStepKind[] _steps = [StackStepKind.Validate, StackStepKind.Pull, StackStepKind.Build, StackStepKind.Up, StackStepKind.Health];

    public Task<JobInfo> DeployAsync(Guid stackId, int number, StackCaller caller, CancellationToken cancellationToken) =>
        DeployAsync(stackId, number, [], caller, cancellationToken);

    /// <summary>
    /// A deploy that signs in to the registries the app sent sign-ins for (E08). They stay in this
    /// job's memory until its pull, build and up steps, which read them from a tmpfs DOCKER_CONFIG
    /// that is wiped when the job ends; the audit trail gets only the registry hosts.
    /// </summary>
    public async Task<JobInfo> DeployAsync(Guid stackId, int number, RegistryAuth[]? auths, StackCaller caller, CancellationToken cancellationToken)
    {
        var stack = await StackAsync(stackId, cancellationToken);
        List<RegistryLogin> logins;
        try
        {
            logins = RegistryCredentials.CheckRequest(auths);
        }
        catch (RegistryRefusedException refused)
        {
            await AuditAsync("stack.deploy", AuditResult.Denied, caller, stack.Name, new(Revision(number)) { ["registryAuth"] = "invalid" }, cancellationToken);
            throw new StackRefusedException(refused.Message);
        }

        return await DeployCheckedAsync(stack, number, logins, caller, cancellationToken);
    }

    private async Task<JobInfo> DeployCheckedAsync(StackRecord stack, int number, List<RegistryLogin> logins, StackCaller caller, CancellationToken cancellationToken)
    {
        var stackId = stack.Id;
        var row = await RevisionAsync(stackId, number, cancellationToken);
        if (row.State is not (nameof(StackRevisionState.Ready) or nameof(StackRevisionState.Failed) or nameof(StackRevisionState.Superseded) or nameof(StackRevisionState.Live)))
        {
            await AuditAsync("stack.deploy", AuditResult.Denied, caller, stack.Name, Revision(number), cancellationToken);
            throw new StackRefusedException(row.State switch
            {
                nameof(StackRevisionState.AwaitingContext) => "This revision is still waiting for its build context.",
                nameof(StackRevisionState.Invalid) => "Docker Compose refused this revision's files, so it cannot be deployed.",
                _ => "This revision is being deployed already.",
            });
        }

        var waiting = ToInfo(row).UnacknowledgedRisks;
        if (waiting.Length > 0)
        {
            await AuditAsync("stack.deploy", AuditResult.Denied, caller, stack.Name, new(Revision(number)) { ["unacknowledged"] = string.Join(' ', waiting) }, cancellationToken);
            throw new StackRefusedException($"Acknowledge every finding before deploying: {string.Join(", ", waiting)}.");
        }

        var previousState = row.State;
        await SetRevisionAsync(stackId, number, nameof(StackRevisionState.Deploying), Pending(row.Builds), null, cancellationToken);
        try
        {
            var job = await jobs.StartAsync(
                new JobRequest(
                    JobKind.StackDeploy,
                    row.RollbackOf is int earlier ? $"Roll {stack.Name} back to revision {earlier}" : $"Deploy {stack.Name} (revision {number})",
                    [LockOf(stack.Name)],
                    stack.Name,
                    caller.UserId,
                    caller.UserName),
                (context, token) => RunDeployAsync(stack, row, logins, context, token),
                cancellationToken);
            var parameters = new Dictionary<string, string?>(Revision(number)) { ["job"] = job.Id.ToString("D") };
            if (logins.Count > 0)
            {
                parameters["registries"] = string.Join(' ', logins.Select(l => l.Registry));
            }

            await AuditAsync("stack.deploy", AuditResult.Success, caller, stack.Name, parameters, cancellationToken);
            return job;
        }
        catch (JobConflictException conflict)
        {
            await SetRevisionAsync(stackId, number, previousState, Read<StackDeployStep[]>(row.Steps), null, CancellationToken.None);
            await AuditAsync("stack.deploy", AuditResult.Failed, caller, stack.Name, new(Revision(number)) { ["busyWith"] = conflict.Holder.Id.ToString("D") }, cancellationToken);
            throw new StackRefusedException(conflict.Message, StatusCodes.Status409Conflict);
        }
    }

    public Task<JobInfo> RollbackAsync(Guid stackId, int number, StackCaller caller, CancellationToken cancellationToken) =>
        RollbackAsync(stackId, number, [], caller, cancellationToken);

    public async Task<JobInfo> RollbackAsync(Guid stackId, int number, RegistryAuth[]? auths, StackCaller caller, CancellationToken cancellationToken)
    {
        var stack = await StackAsync(stackId, cancellationToken);
        List<RegistryLogin> logins;
        try
        {
            logins = RegistryCredentials.CheckRequest(auths);
        }
        catch (RegistryRefusedException refused)
        {
            await AuditAsync("stack.rollback", AuditResult.Denied, caller, stack.Name, new(Revision(number)) { ["registryAuth"] = "invalid" }, cancellationToken);
            throw new StackRefusedException(refused.Message);
        }

        var source = await RevisionAsync(stackId, number, cancellationToken);
        if (source.DeployedAt is null || source.State is nameof(StackRevisionState.Deploying) or nameof(StackRevisionState.Invalid) or nameof(StackRevisionState.AwaitingContext))
        {
            await AuditAsync("stack.rollback", AuditResult.Denied, caller, stack.Name, Revision(number), cancellationToken);
            throw new StackRefusedException("Only a revision that was deployed before can be rolled back to.");
        }

        if (stack.LiveRevision == number)
        {
            throw new StackRefusedException($"Revision {number} is what runs now.");
        }

        int copy;
        await _gate.WaitAsync(cancellationToken);
        try
        {
            await using var db = await contexts.CreateDbContextAsync(cancellationToken);
            var tracked = await db.Stacks.FirstAsync(s => s.Id == stackId, cancellationToken);
            copy = tracked.LastRevision + 1;
            var target = RevisionFolder(stackId, copy);
            if (Directory.Exists(target))
            {
                Directory.Delete(target, recursive: true);
            }

            CopyFolder(RevisionFolder(stackId, number), target);
            tracked.LastRevision = copy;
            tracked.UpdatedAt = Now;
            db.StackRevisions.Add(new StackRevisionRecord
            {
                StackId = stackId,
                Number = copy,
                State = nameof(StackRevisionState.Ready),
                CreatedAt = Now,
                CreatedBy = caller.UserName,
                ComposeSha256 = source.ComposeSha256,
                EnvKeys = source.EnvKeys,
                Services = source.Services,
                ProxiedServices = source.ProxiedServices,
                Findings = source.Findings,
                AcknowledgedRisks = source.AcknowledgedRisks,
                Bindings = source.Bindings,
                Builds = source.Builds,
                HasBuildContext = source.HasBuildContext,
                RollbackOf = number,
                ProjectId = source.ProjectId,
                ProjectName = source.ProjectName,
                ComposePath = source.ComposePath,
                EnvironmentId = source.EnvironmentId,
                EnvironmentName = source.EnvironmentName,
            });
            await db.SaveChangesAsync(cancellationToken);
        }
        finally
        {
            _gate.Release();
        }

        await AuditAsync("stack.rollback", AuditResult.Success, caller, stack.Name, new(Revision(number)) { ["copy"] = copy.ToString(CultureInfo.InvariantCulture) }, cancellationToken);
        return await DeployCheckedAsync(await StackAsync(stackId, cancellationToken), copy, logins, caller, cancellationToken);
    }

    public async Task<JobInfo> RunActionAsync(Guid stackId, StackAction action, StackCaller caller, CancellationToken cancellationToken)
    {
        var stack = await StackAsync(stackId, cancellationToken);
        var name = action.ToString().ToLowerInvariant();
        if (!Enum.IsDefined(action) || stack.LiveRevision is not int live)
        {
            await AuditAsync($"stack.{name}", AuditResult.Denied, caller, stack.Name, null, cancellationToken);
            throw new StackRefusedException(Enum.IsDefined(action) ? "Deploy the app first." : "That is not something an app can do.");
        }

        string[] arguments = action switch
        {
            StackAction.Start => ["start"],
            StackAction.Stop => ["stop"],
            StackAction.Restart => ["restart"],
            _ => ["down", "--remove-orphans"],
        };
        var title = action switch
        {
            StackAction.Start => $"Start {stack.Name}",
            StackAction.Stop => $"Stop {stack.Name}",
            StackAction.Restart => $"Restart {stack.Name}",
            _ => $"Take {stack.Name} down",
        };
        var folder = RevisionFolder(stackId, live);
        return await StartAsync($"stack.{name}", caller, stack, new JobRequest(JobKind.StackAction, title, [LockOf(stack.Name)], stack.Name, caller.UserId, caller.UserName), async (job, token) =>
        {
            job.Seed(await EnvValuesAsync(folder, token));
            await ComposeStepAsync(job, Project(stack.Name, folder), arguments, ActionTimeout, "stackaction", token);
        }, cancellationToken);
    }

    public async Task<JobInfo> DeleteAsync(Guid stackId, bool removeVolumes, StackCaller caller, CancellationToken cancellationToken)
    {
        var stack = await StackAsync(stackId, cancellationToken);
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var revisions = await db.StackRevisions.AsNoTracking().Where(r => r.StackId == stackId).ToListAsync(cancellationToken);
        var runnable = revisions.FirstOrDefault(r => r.Number == stack.LiveRevision)
            ?? revisions.Where(r => r.DeployedAt is not null).OrderByDescending(r => r.Number).FirstOrDefault();
        var parameters = new Dictionary<string, string?> { ["volumes"] = removeVolumes ? "true" : "false" };
        return await StartAsync(
            "stack.delete",
            caller,
            stack,
            new JobRequest(JobKind.StackDelete, removeVolumes ? $"Delete {stack.Name} and its volumes" : $"Delete {stack.Name}", [LockOf(stack.Name)], stack.Name, caller.UserId, caller.UserName),
            async (job, token) =>
            {
                if (runnable is not null)
                {
                    var folder = RevisionFolder(stackId, runnable.Number);
                    job.Seed(await EnvValuesAsync(folder, token));
                    string[] down = removeVolumes ? ["down", "--remove-orphans", "--volumes"] : ["down", "--remove-orphans"];
                    await ComposeStepAsync(job, Project(stack.Name, folder), down, ActionTimeout, "stackdelete", token);
                }
                else
                {
                    job.Log($"{stack.Name} never ran, so there is nothing to take down.");
                }

                await using (var write = await contexts.CreateDbContextAsync(CancellationToken.None))
                {
                    await write.Stacks.Where(s => s.Id == stackId).ExecuteDeleteAsync(CancellationToken.None);
                }

                try
                {
                    Directory.Delete(StackFolder(stackId), recursive: true);
                }
                catch (DirectoryNotFoundException)
                {
                    // Nothing was ever uploaded.
                }

                job.Log(removeVolumes ? $"{stack.Name} and its volumes are gone." : $"{stack.Name} is gone. Its volumes are kept.");
            },
            cancellationToken,
            parameters);
    }

    private async Task<JobInfo> StartAsync(
        string action,
        StackCaller caller,
        StackRecord stack,
        JobRequest request,
        JobWork work,
        CancellationToken cancellationToken,
        Dictionary<string, string?>? parameters = null)
    {
        try
        {
            var job = await jobs.StartAsync(request, work, cancellationToken);
            await AuditAsync(action, AuditResult.Success, caller, stack.Name, new(parameters ?? []) { ["job"] = job.Id.ToString("D") }, cancellationToken);
            return job;
        }
        catch (JobConflictException conflict)
        {
            await AuditAsync(action, AuditResult.Failed, caller, stack.Name, new(parameters ?? []) { ["busyWith"] = conflict.Holder.Id.ToString("D") }, cancellationToken);
            throw new StackRefusedException(conflict.Message, StatusCodes.Status409Conflict);
        }
    }

    private async Task RunDeployAsync(StackRecord stack, StackRevisionRecord row, IReadOnlyList<RegistryLogin> requested, JobContext job, CancellationToken token)
    {
        var folder = RevisionFolder(stack.Id, row.Number);
        job.Seed(await EnvValuesAsync(folder, token));
        job.Seed(RegistrySecrets(requested));
        using var signIns = new DeploySignIns(requested);
        var steps = Pending(row.Builds).ToList();
        await using (var db = await contexts.CreateDbContextAsync(CancellationToken.None))
        {
            await db.StackRevisions
                .Where(r => r.StackId == stack.Id && r.Number == row.Number)
                .ExecuteUpdateAsync(u => u.SetProperty(r => r.JobId, job.Id).SetProperty(r => r.DeployedAt, Now), CancellationToken.None);
        }

        var proxied = Read<string[]>(row.ProxiedServices);
        var acknowledged = Read<string[]>(row.AcknowledgedRisks);
        var project = Project(stack.Name, folder);
        var current = -1;
        try
        {
            for (current = 0; current < steps.Count; current++)
            {
                var kind = steps[current].Kind;
                if (steps[current].State == StackStepState.Skipped)
                {
                    continue;
                }

                steps[current] = steps[current] with { State = StackStepState.Running, StartedAtUnixMs = Now, FirstLogSeq = job.LogLines + 1 };
                await SaveStepsAsync(stack.Id, row.Number, steps);
                job.Log($"Step: {Describe(kind)}.");
                var detail = await RunStepAsync(kind, stack, folder, project, proxied, acknowledged, signIns, job, token);
                steps[current] = steps[current] with { State = StackStepState.Succeeded, FinishedAtUnixMs = Now, LastLogSeq = job.LogLines, Detail = detail };
                await SaveStepsAsync(stack.Id, row.Number, steps);
            }
        }
        catch (Exception error)
        {
            var cancelled = error is OperationCanceledException && token.IsCancellationRequested;
            var message = error switch
            {
                JobFailedException failed => failed.Message,
                ComposeConfigException config => config.Message,
                _ when cancelled => "Cancelled.",
                _ => "The step stopped on an unexpected error.",
            };
            for (var i = 0; i < steps.Count; i++)
            {
                if (i == current)
                {
                    steps[i] = steps[i] with
                    {
                        State = cancelled ? StackStepState.Cancelled : StackStepState.Failed,
                        FinishedAtUnixMs = Now,
                        LastLogSeq = job.LogLines,
                        Detail = Clip(job.Redactor.Redact(message)),
                    };
                }
                else if (steps[i].State == StackStepState.Pending)
                {
                    steps[i] = steps[i] with { State = StackStepState.Skipped };
                }
            }

            await FinishRevisionAsync(stack.Id, row.Number, nameof(StackRevisionState.Failed), steps, Clip(job.Redactor.Redact(message)));
            if (error is ComposeConfigException)
            {
                throw new JobFailedException(message);
            }

            throw;
        }

        await FinishRevisionAsync(stack.Id, row.Number, nameof(StackRevisionState.Live), steps, null);
        job.Log($"{stack.Name} runs revision {row.Number}.");
    }

    private async Task<string?> RunStepAsync(
        StackStepKind kind,
        StackRecord stack,
        string folder,
        ComposeProject project,
        string[] proxied,
        string[] acknowledged,
        DeploySignIns signIns,
        JobContext job,
        CancellationToken token)
    {
        switch (kind)
        {
            case StackStepKind.Validate:
                var checkedConfig = await CheckAsync(stack, folder, proxied, line => job.Log(line), token);
                var waiting = Unacknowledged(checkedConfig.Findings, acknowledged);
                if (waiting.Length > 0)
                {
                    throw new JobFailedException($"Compose now reads findings nobody acknowledged: {string.Join(", ", waiting)}.");
                }

                foreach (var binding in checkedConfig.Bindings)
                {
                    job.Log($"{binding.Service} publishes {binding.Target}/{binding.Protocol} on {binding.HostIp ?? "every interface"}{(binding.Published is null ? string.Empty : $" port {binding.Published}")}.");
                }

                await SignInAsync(signIns, checkedConfig, job, token);
                return $"{checkedConfig.Services.Length} services";
            case StackStepKind.Pull:
                await ComposeStepAsync(job, project, ["pull", "--ignore-buildable"], PullTimeout, "stackpull", token, signIns.Environment);
                return null;
            case StackStepKind.Build:
                await ComposeStepAsync(job, project, ["build"], BuildTimeout, "stackbuild", token, signIns.Environment);
                return null;
            case StackStepKind.Up:
                await ComposeStepAsync(
                    job,
                    project,
                    ["up", "--detach", "--wait", "--wait-timeout", "300", "--remove-orphans"],
                    UpTimeout,
                    "stackup",
                    token,
                    signIns.Environment);
                return null;
            default:
                return await HealthAsync(stack.Name, job, token);
        }
    }

    private async Task<string> HealthAsync(string name, JobContext job, CancellationToken token)
    {
        var deadline = time.GetUtcNow() + HealthWait;
        while (true)
        {
            List<ContainerSummary> containers;
            try
            {
                containers = [.. (await engine.ListContainersAsync(token)).Select(c => c.Summary).Where(c => c.ComposeProject == name)];
            }
            catch (DockerUnavailableException unavailable)
            {
                throw new JobFailedException(unavailable.Message);
            }

            var unhealthy = containers.Where(c => c.Health == ContainerHealth.Unhealthy).Select(c => c.Name).ToList();
            var stopped = containers.Where(c => c.State != ContainerState.Running).Select(c => c.Name).ToList();
            if (containers.Count > 0 && unhealthy.Count == 0 && stopped.Count == 0)
            {
                foreach (var container in containers.OrderBy(c => c.Name, StringComparer.Ordinal))
                {
                    job.Log($"{container.Name} is running{(container.Health == ContainerHealth.Healthy ? " and healthy" : string.Empty)}.");
                }

                return $"{containers.Count} containers running";
            }

            if (time.GetUtcNow() >= deadline)
            {
                throw new JobFailedException(containers.Count == 0
                    ? "No container of the app is running."
                    : unhealthy.Count > 0
                        ? $"Unhealthy: {string.Join(", ", unhealthy)}."
                        : $"Not running: {string.Join(", ", stopped)}.");
            }

            await Task.Delay(HealthPoll, time, token);
        }
    }

    private async Task ComposeStepAsync(
        JobContext job,
        ComposeProject project,
        string[] arguments,
        TimeSpan timeout,
        string unit,
        CancellationToken token,
        IReadOnlyDictionary<string, string>? environment = null)
    {
        ProcessResult result;
        try
        {
            result = await compose.RunAsync(project, arguments, new ComposeRunOptions(timeout, job.UnitFor(unit), Environment: environment), job.Output, token);
        }
        catch (ProcessStartException)
        {
            throw new JobFailedException("Docker is not installed on this server.");
        }

        job.ExitCode = result.ExitCode;
        if (result.TimedOut)
        {
            throw new JobFailedException($"docker compose {arguments[0]} did not finish within {timeout.TotalMinutes:0} minutes.");
        }

        if (!result.Succeeded)
        {
            throw new JobFailedException($"docker compose {arguments[0]} failed (exit code {result.ExitCode}).", result.ExitCode);
        }
    }

    private static StackDeployStep[] Pending(bool builds) =>
        [.. _steps.Select(kind => new StackDeployStep(kind, kind == StackStepKind.Build && !builds ? StackStepState.Skipped : StackStepState.Pending))];

    private static string Describe(StackStepKind kind) => kind switch
    {
        StackStepKind.Validate => "check the files with docker compose config",
        StackStepKind.Pull => "pull the images",
        StackStepKind.Build => "build the images",
        StackStepKind.Up => "start the containers and wait for them",
        _ => "check that every container runs",
    };

    private static Dictionary<string, string?> Revision(int number) =>
        new() { ["revision"] = number.ToString(CultureInfo.InvariantCulture) };

    private async Task SetRevisionAsync(Guid stackId, int number, string state, IReadOnlyList<StackDeployStep> steps, string? error, CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var json = Write(steps);
        await db.StackRevisions
            .Where(r => r.StackId == stackId && r.Number == number)
            .ExecuteUpdateAsync(u => u.SetProperty(r => r.State, state).SetProperty(r => r.Steps, json).SetProperty(r => r.Error, error), cancellationToken);
    }

    private async Task SaveStepsAsync(Guid stackId, int number, IReadOnlyList<StackDeployStep> steps)
    {
        await using var db = await contexts.CreateDbContextAsync(CancellationToken.None);
        var json = Write(steps);
        await db.StackRevisions
            .Where(r => r.StackId == stackId && r.Number == number)
            .ExecuteUpdateAsync(u => u.SetProperty(r => r.Steps, json), CancellationToken.None);
    }

    private async Task FinishRevisionAsync(Guid stackId, int number, string state, IReadOnlyList<StackDeployStep> steps, string? error)
    {
        var now = Now;
        var json = Write(steps);
        await using var db = await contexts.CreateDbContextAsync(CancellationToken.None);
        if (state == nameof(StackRevisionState.Live))
        {
            await db.StackRevisions
                .Where(r => r.StackId == stackId && r.Number != number && r.State == nameof(StackRevisionState.Live))
                .ExecuteUpdateAsync(u => u.SetProperty(r => r.State, nameof(StackRevisionState.Superseded)), CancellationToken.None);
            await db.Stacks
                .Where(s => s.Id == stackId)
                .ExecuteUpdateAsync(u => u.SetProperty(s => s.LiveRevision, number).SetProperty(s => s.UpdatedAt, now), CancellationToken.None);
        }

        await db.StackRevisions
            .Where(r => r.StackId == stackId && r.Number == number)
            .ExecuteUpdateAsync(
                u => u.SetProperty(r => r.State, state).SetProperty(r => r.Steps, json).SetProperty(r => r.Error, error).SetProperty(r => r.FinishedAt, now),
                CancellationToken.None);
    }

    /// <summary>Deploys a previous core left running end as failed: nobody saw them finish.</summary>
    public async Task<int> RecoverAsync(CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var stuck = await db.StackRevisions.Where(r => r.State == nameof(StackRevisionState.Deploying)).ToListAsync(cancellationToken);
        foreach (var row in stuck)
        {
            row.State = nameof(StackRevisionState.Failed);
            row.Error = "The core stopped during this deploy.";
            row.FinishedAt = Now;
            row.Steps = Write(Read<StackDeployStep[]>(row.Steps).Select(step => step.State switch
            {
                StackStepState.Running => step with { State = StackStepState.Failed, Detail = "The core stopped during this step." },
                StackStepState.Pending => step with { State = StackStepState.Skipped },
                _ => step,
            }).ToArray());
        }

        await db.SaveChangesAsync(cancellationToken);
        if (stuck.Count > 0)
        {
            LogRecovered(logger, stuck.Count);
        }

        return stuck.Count;
    }

    /// <summary>A revision copied for a rollback, links kept as links (the extractor allowed only inside ones).</summary>
    private static void CopyFolder(string source, string target)
    {
        CreatePrivateFolder(target);
        foreach (var entry in new DirectoryInfo(source).EnumerateFileSystemInfos())
        {
            var destination = Path.Combine(target, entry.Name);
            if (entry.LinkTarget is { } link)
            {
                if (entry is DirectoryInfo)
                {
                    Directory.CreateSymbolicLink(destination, link);
                }
                else
                {
                    File.CreateSymbolicLink(destination, link);
                }
            }
            else if (entry is DirectoryInfo folder)
            {
                CopyFolder(folder.FullName, destination);
                if (!OperatingSystem.IsWindows())
                {
                    File.SetUnixFileMode(destination, File.GetUnixFileMode(folder.FullName));
                }
            }
            else
            {
                File.Copy(entry.FullName, destination);
                if (!OperatingSystem.IsWindows())
                {
                    File.SetUnixFileMode(destination, File.GetUnixFileMode(entry.FullName));
                }
            }
        }
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "Marked {Count} stack deploys failed: the core stopped while they ran.")]
    private static partial void LogRecovered(ILogger logger, int count);
}
