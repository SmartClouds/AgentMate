using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Runova.ServerCore.Audit;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Docker;
using Runova.ServerCore.Hosting;
using Runova.ServerCore.Jobs;
using Runova.ServerCore.Registries;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Stacks;

/// <summary>Who asked, for the audit trail and the jobs' "started by".</summary>
internal sealed record StackCaller(Guid UserId, string UserName, Guid? DeviceId = null, int? PeerUid = null);

/// <summary>A request the core turns down, with the words to show and the HTTP status for REST.</summary>
internal sealed class StackRefusedException(string message, int status = StatusCodes.Status400BadRequest) : Exception(message)
{
    public int Status { get; } = status;
}

/// <summary>
/// Compose stacks: the records, the files of each revision under &lt;data&gt;/stacks, validation with
/// `docker compose config`, and the jobs that deploy, roll back, run the lifecycle and delete.
/// Every change lands in the audit trail; env values only ever live in a revision's .env (0600)
/// and in the redactor that masks them in job logs and errors.
/// </summary>
internal sealed partial class StackOperations(
    IDbContextFactory<CoreDbContext> contexts,
    CoreDirectories directories,
    IComposeRunner compose,
    IDockerEngine engine,
    JobEngine jobs,
    AuditLog audit,
    Redactor redactor,
    TimeProvider time,
    ILogger<StackOperations> logger,
    RegistryCredentials registries,
    RegistryAuthFolders registryFolders) : IDisposable
{
    public const string ComposeFileName = "compose.yaml";

    public const string EnvFileName = ".env";

    public const string FilesFolder = "files";

    public const int MaxRevisionsShown = 50;

    private readonly SemaphoreSlim _gate = new(1, 1);

    private long Now => time.GetUtcNow().ToUnixTimeMilliseconds();

    public void Dispose() => _gate.Dispose();

    public static string LockOf(string name) => $"stack:{name}";

    public string StackFolder(Guid stackId) => Path.Combine(directories.Stacks, stackId.ToString("N"));

    public string RevisionFolder(Guid stackId, int number) =>
        Path.Combine(StackFolder(stackId), "revisions", number.ToString(System.Globalization.CultureInfo.InvariantCulture));

    public async Task<StackInfo[]> ListAsync(CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var stacks = await db.Stacks.AsNoTracking().OrderBy(s => s.Name).ToListAsync(cancellationToken);
        var revisions = await db.StackRevisions.AsNoTracking()
            .Select(r => new { r.StackId, r.Number, r.State, r.DeployedAt })
            .ToListAsync(cancellationToken);
        var containers = await ContainersAsync(cancellationToken);
        return [.. stacks.Select(stack =>
        {
            var own = revisions.Where(r => r.StackId == stack.Id).ToList();
            var lastDeployed = own.Where(r => r.DeployedAt is not null).OrderByDescending(r => r.Number).FirstOrDefault()?.State;
            return Info(stack, own.Count, lastDeployed, Of(containers, stack.Name));
        })];
    }

    public async Task<StackDetails> GetAsync(Guid stackId, CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var stack = await db.Stacks.AsNoTracking().FirstOrDefaultAsync(s => s.Id == stackId, cancellationToken)
            ?? throw new StackRefusedException("There is no such app.", StatusCodes.Status404NotFound);
        var rows = await db.StackRevisions.AsNoTracking()
            .Where(r => r.StackId == stackId)
            .OrderByDescending(r => r.Number)
            .ToListAsync(cancellationToken);
        var containers = Of(await ContainersAsync(cancellationToken), stack.Name);
        var lastDeployed = rows.FirstOrDefault(r => r.DeployedAt is not null)?.State;
        var shown = rows.FirstOrDefault(r => r.Number == stack.LiveRevision) ?? rows.FirstOrDefault();
        var serviceNames = shown is null ? [] : Read<string[]>(shown.Services);
        var bindings = shown is null ? [] : Read<StackPortBinding[]>(shown.Bindings);
        var services = serviceNames
            .Concat(containers.Select(c => c.ComposeService).OfType<string>())
            .Distinct(StringComparer.Ordinal)
            .Select(name => new StackServiceInfo(
                name,
                [.. containers.Where(c => c.ComposeService == name).OrderBy(c => c.ComposeNumber ?? 0)],
                [.. bindings.Where(b => b.Service == name)],
                containers.FirstOrDefault(c => c.ComposeService == name)?.Image))
            .ToArray();
        return new StackDetails(
            Info(stack, rows.Count, lastDeployed, containers),
            [.. rows.Take(MaxRevisionsShown).Select(ToInfo)],
            services);
    }

    public async Task<StackRevisionFiles> FilesAsync(Guid stackId, int number, CancellationToken cancellationToken)
    {
        var row = await RevisionAsync(stackId, number, cancellationToken);
        var folder = RevisionFolder(stackId, number);
        var compose = await File.ReadAllTextAsync(Path.Combine(folder, ComposeFileName), cancellationToken);
        var overridePath = LoopbackOverride.PathIn(folder);
        var overrideText = File.Exists(overridePath) ? await File.ReadAllTextAsync(overridePath, cancellationToken) : null;
        return new StackRevisionFiles(number, compose, Read<string[]>(row.EnvKeys), overrideText);
    }

    public async Task<StackInfo> CreateAsync(CreateStackRequest request, StackCaller caller, CancellationToken cancellationToken)
    {
        if (request is null || StackRules.StackNameProblem(request.Name) is { } problem)
        {
            await AuditAsync("stack.create", AuditResult.Denied, caller, request?.Name is { Length: <= 63 } name ? name : null, null, cancellationToken);
            throw new StackRefusedException(request is null ? "Name the app." : StackRules.StackNameProblem(request.Name)!);
        }

        if (request.Description is { Length: > StackRules.MaxDescriptionLength })
        {
            throw new StackRefusedException($"Keep the description to {StackRules.MaxDescriptionLength} characters or fewer.");
        }

        CheckSource(request.Source);
        await _gate.WaitAsync(cancellationToken);
        try
        {
            await using var db = await contexts.CreateDbContextAsync(cancellationToken);
            if (await db.Stacks.AnyAsync(s => s.Name == request.Name, cancellationToken))
            {
                await AuditAsync("stack.create", AuditResult.Failed, caller, request.Name, null, cancellationToken);
                throw new StackRefusedException($"There is already an app called {request.Name} on this server.", StatusCodes.Status409Conflict);
            }

            var now = Now;
            var stack = new StackRecord
            {
                Id = Guid.NewGuid(),
                Name = request.Name,
                Description = string.IsNullOrWhiteSpace(request.Description) ? null : request.Description.Trim(),
                CreatedAt = now,
                UpdatedAt = now,
            };
            ApplySource(stack, request.Source);
            db.Stacks.Add(stack);
            await db.SaveChangesAsync(cancellationToken);
            await AuditAsync("stack.create", AuditResult.Success, caller, stack.Name, null, cancellationToken);
            return Info(stack, 0, null, []);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<StackRevisionInfo> AcknowledgeAsync(AcknowledgeStackRisksRequest request, StackCaller caller, CancellationToken cancellationToken)
    {
        if (request is null || request.RiskIds is null || request.RiskIds.Length is 0 or > StackRules.MaxAcknowledgments
            || !request.RiskIds.All(StackRules.IsRiskId))
        {
            throw new StackRefusedException("Name the findings to acknowledge by their ids.");
        }

        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        var stack = await db.Stacks.FirstOrDefaultAsync(s => s.Id == request.StackId, cancellationToken)
            ?? throw new StackRefusedException("There is no such app.", StatusCodes.Status404NotFound);
        var row = await db.StackRevisions.FirstOrDefaultAsync(r => r.StackId == request.StackId && r.Number == request.Revision, cancellationToken)
            ?? throw new StackRefusedException("There is no such revision.", StatusCodes.Status404NotFound);
        var acknowledged = Read<string[]>(row.AcknowledgedRisks).ToList();
        var added = request.RiskIds.Distinct(StringComparer.Ordinal).Where(id => !acknowledged.Contains(id)).ToList();
        acknowledged.AddRange(added);
        row.AcknowledgedRisks = Write(acknowledged);
        await db.SaveChangesAsync(cancellationToken);
        foreach (var id in added)
        {
            await AcknowledgmentAuditAsync(caller, stack.Name, row.Number, id, cancellationToken);
        }

        return ToInfo(row);
    }

    internal async Task<StackRevisionRecord> RevisionAsync(Guid stackId, int number, CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        return await db.StackRevisions.AsNoTracking().FirstOrDefaultAsync(r => r.StackId == stackId && r.Number == number, cancellationToken)
            ?? throw new StackRefusedException("There is no such revision.", StatusCodes.Status404NotFound);
    }

    internal async Task<StackRecord> StackAsync(Guid stackId, CancellationToken cancellationToken)
    {
        await using var db = await contexts.CreateDbContextAsync(cancellationToken);
        return await db.Stacks.AsNoTracking().FirstOrDefaultAsync(s => s.Id == stackId, cancellationToken)
            ?? throw new StackRefusedException("There is no such app.", StatusCodes.Status404NotFound);
    }

    public Task AuditAsync(string action, string result, StackCaller caller, string? target, Dictionary<string, string?>? parameters, CancellationToken cancellationToken) =>
        audit.AppendAsync(new AuditEntry(action, result, caller.UserId, caller.DeviceId, caller.PeerUid, target, parameters), cancellationToken);

    private Task AcknowledgmentAuditAsync(StackCaller caller, string stack, int revision, string finding, CancellationToken cancellationToken) =>
        AuditAsync(
            "stack.risk-acknowledge",
            AuditResult.Success,
            caller,
            stack,
            new Dictionary<string, string?>
            {
                ["revision"] = revision.ToString(System.Globalization.CultureInfo.InvariantCulture),
                ["finding"] = finding,
            },
            cancellationToken);

    private StackInfo Info(StackRecord stack, int revisionCount, string? lastDeployedState, List<ContainerSummary> containers)
    {
        var holder = jobs.Holder(LockOf(stack.Name));
        var running = containers.Count(c => c.State == ContainerState.Running);
        var status = holder is not null
            ? StackStatus.Busy
            : containers.Count == 0
                ? lastDeployedState == nameof(StackRevisionState.Failed)
                    ? StackStatus.Failed
                    : stack.LiveRevision is null ? StackStatus.New : StackStatus.Down
                : running == containers.Count && containers.All(c => c.Health != ContainerHealth.Unhealthy)
                    ? StackStatus.Running
                    : running > 0 ? StackStatus.Degraded : StackStatus.Stopped;
        return new StackInfo(
            stack.Id,
            stack.Name,
            status,
            stack.CreatedAt,
            stack.UpdatedAt,
            revisionCount,
            stack.LiveRevision,
            stack.Description,
            SourceOf(stack.ProjectId, stack.ProjectName, stack.ComposePath, stack.EnvironmentId, stack.EnvironmentName),
            running,
            containers.Count,
            holder?.Id);
    }

    internal static StackRevisionInfo ToInfo(StackRevisionRecord row)
    {
        var findings = Read<StackRisk[]>(row.Findings);
        var acknowledged = Read<string[]>(row.AcknowledgedRisks);
        return new StackRevisionInfo(
            row.StackId,
            row.Number,
            Enum.Parse<StackRevisionState>(row.State),
            row.CreatedAt,
            row.ComposeSha256,
            Read<string[]>(row.EnvKeys),
            Read<string[]>(row.Services),
            Read<string[]>(row.ProxiedServices),
            row.HasBuildContext,
            Read<StackDeployStep[]>(row.Steps),
            findings,
            acknowledged,
            Unacknowledged(findings, acknowledged),
            Read<StackPortBinding[]>(row.Bindings),
            row.CreatedBy,
            row.JobId,
            row.DeployedAt,
            row.FinishedAt,
            row.RollbackOf,
            row.Error,
            SourceOf(row.ProjectId, row.ProjectName, row.ComposePath, row.EnvironmentId, row.EnvironmentName));
    }

    internal static string[] Unacknowledged(IEnumerable<StackRisk> findings, IEnumerable<string> acknowledged)
    {
        var done = acknowledged.ToHashSet(StringComparer.Ordinal);
        return [.. findings.Where(f => ComposeConfigLint.NeedsAcknowledgment(f.Severity) && !done.Contains(f.Id)).Select(f => f.Id)];
    }

    private static StackSource? SourceOf(string? projectId, string? projectName, string? composePath, string? environmentId, string? environmentName) =>
        projectId is null && projectName is null && composePath is null && environmentId is null && environmentName is null
            ? null
            : new StackSource(projectId, projectName, composePath, environmentId, environmentName);

    private static void CheckSource(StackSource? source)
    {
        if (source is null)
        {
            return;
        }

        string?[] fields = [source.ProjectId, source.ProjectName, source.ComposePath, source.EnvironmentId, source.EnvironmentName];
        if (fields.Any(field => field is { Length: > StackRules.MaxSourceLength } || (field is not null && field.Any(char.IsControl))))
        {
            throw new StackRefusedException("The source of the files is described with names that are too long or unreadable.");
        }
    }

    private static void ApplySource(StackRecord stack, StackSource? source)
    {
        if (source is null)
        {
            return;
        }

        stack.ProjectId = source.ProjectId;
        stack.ProjectName = source.ProjectName;
        stack.ComposePath = source.ComposePath;
        stack.EnvironmentId = source.EnvironmentId;
        stack.EnvironmentName = source.EnvironmentName;
    }

    private async Task<IReadOnlyList<ContainerSummary>> ContainersAsync(CancellationToken cancellationToken)
    {
        try
        {
            return [.. (await engine.ListContainersAsync(cancellationToken)).Select(c => c.Summary)];
        }
        catch (DockerUnavailableException)
        {
            return [];
        }
    }

    private static List<ContainerSummary> Of(IReadOnlyList<ContainerSummary> containers, string project) =>
        [.. containers.Where(c => c.ComposeProject == project)];

    internal static T Read<T>(string json) => JsonSerializer.Deserialize<T>(json, CoreJson.Options)!;

    internal static string Write<T>(T value) => JsonSerializer.Serialize(value, CoreJson.Options);
}
