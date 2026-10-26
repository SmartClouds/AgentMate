using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Runova.ServerCore.Audit;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;

namespace Runova.ServerCore.Stacks;

/// <summary>
/// Revisions made on the server from an existing one: the folder copied as a rollback copies it
/// (the .env and the project files with it), then a new compose file or another set of proxied
/// services, and the same validation as an upload. This is how an App Store app moves to newer
/// images and how "make private" puts a service on loopback without any env value leaving the
/// core. Also revealing a revision's .env, for Admins after a step-up.
/// </summary>
internal sealed partial class StackOperations
{
    public async Task<StackRevisionInfo> ReviseAsync(ReviseStackRequest? request, StackCaller caller, CancellationToken cancellationToken)
    {
        if (request is null)
        {
            throw new StackRefusedException("Name the app and the revision to start from.");
        }

        var stack = await StackAsync(request.StackId, cancellationToken);
        var purpose = PurposeName(request.Purpose);
        var problem = CheckRevise(request);
        StackRevisionRecord? source = null;
        if (problem.Length == 0)
        {
            try
            {
                source = await RevisionAsync(request.StackId, request.Revision, cancellationToken);
            }
            catch (StackRefusedException missing)
            {
                problem = missing.Message;
            }
        }

        if (source is { State: nameof(StackRevisionState.AwaitingContext) })
        {
            problem = "That revision is still waiting for its build context.";
        }

        if (problem.Length > 0 || source is null)
        {
            await AuditAsync("stack.revise", AuditResult.Denied, caller, stack.Name, new(Revision(request.Revision)) { ["purpose"] = purpose, ["reason"] = problem }, cancellationToken);
            throw new StackRefusedException(problem);
        }

        int number;
        await _gate.WaitAsync(cancellationToken);
        try
        {
            await using var db = await contexts.CreateDbContextAsync(cancellationToken);
            var tracked = await db.Stacks.FirstAsync(s => s.Id == stack.Id, cancellationToken);
            number = tracked.LastRevision + 1;
            var target = RevisionFolder(stack.Id, number);
            if (Directory.Exists(target))
            {
                Directory.Delete(target, recursive: true);
            }

            CopyFolder(RevisionFolder(stack.Id, request.Revision), target);
            var composeSha = source.ComposeSha256;
            if (request.Compose is { } compose)
            {
                var bytes = Encoding.UTF8.GetBytes(compose);
                await WritePrivateAsync(Path.Combine(target, ComposeFileName), bytes, cancellationToken);
                composeSha = Convert.ToHexStringLower(SHA256.HashData(bytes));
            }

            var acknowledged = request.AcknowledgedRisks is { } risks
                ? Write(risks.Distinct(StringComparer.Ordinal).ToArray())
                : source.AcknowledgedRisks;
            tracked.LastRevision = number;
            tracked.UpdatedAt = Now;
            db.StackRevisions.Add(new StackRevisionRecord
            {
                StackId = stack.Id,
                Number = number,
                State = nameof(StackRevisionState.Ready),
                CreatedAt = Now,
                CreatedBy = caller.UserName,
                ComposeSha256 = composeSha,
                EnvKeys = source.EnvKeys,
                Services = source.Services,
                ProxiedServices = Write(request.ProxiedServices.Distinct(StringComparer.Ordinal).ToArray()),
                Findings = source.Findings,
                AcknowledgedRisks = acknowledged,
                Bindings = source.Bindings,
                Builds = source.Builds,
                HasBuildContext = source.HasBuildContext,
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

        await AuditAsync(
            "stack.revise",
            AuditResult.Success,
            caller,
            stack.Name,
            new(Revision(request.Revision))
            {
                ["copy"] = number.ToString(CultureInfo.InvariantCulture),
                ["purpose"] = purpose,
                ["compose"] = request.Compose is null ? "kept" : "replaced",
                ["proxied"] = string.Join(' ', request.ProxiedServices.Distinct(StringComparer.Ordinal)),
            },
            cancellationToken);
        if (request.AcknowledgedRisks is { } listed)
        {
            foreach (var id in listed.Distinct(StringComparer.Ordinal))
            {
                await AcknowledgmentAuditAsync(caller, stack.Name, number, id, cancellationToken);
            }
        }

        return await ValidateAsync(stack, number, cancellationToken);
    }

    public async Task<StackEnvEntry[]> RevealEnvAsync(StackRevisionRef? revision, StackCaller caller, CancellationToken cancellationToken)
    {
        if (revision is null)
        {
            throw new StackRefusedException("Name the app and the revision.");
        }

        var stack = await StackAsync(revision.StackId, cancellationToken);
        await RevisionAsync(revision.StackId, revision.Revision, cancellationToken);
        var path = Path.Combine(RevisionFolder(stack.Id, revision.Revision), EnvFileName);
        var parsed = ComposeEnvFile.Parse(File.Exists(path) ? await File.ReadAllTextAsync(path, cancellationToken) : string.Empty);
        StackEnvEntry[] entries = [.. parsed.Entries.Select(e => new StackEnvEntry(e.Key, e.Value))];
        // The keys and values stay out of the trail; how many were shown is enough.
        await AuditAsync(
            "stack.env-reveal",
            AuditResult.Success,
            caller,
            stack.Name,
            new(Revision(revision.Revision)) { ["variables"] = entries.Length.ToString(CultureInfo.InvariantCulture) },
            cancellationToken);
        return entries;
    }

    private static string PurposeName(StackRevisionPurpose purpose) => purpose switch
    {
        StackRevisionPurpose.MakePrivate => "make-private",
        StackRevisionPurpose.Update => "update",
        _ => "edit",
    };

    private static string CheckRevise(ReviseStackRequest request)
    {
        if (request.Revision < 1)
        {
            return "There is no such revision.";
        }

        if (request.ProxiedServices is null || request.ProxiedServices.Length > StackRules.MaxServices || !request.ProxiedServices.All(StackRules.IsServiceName))
        {
            return "The proxied services are not service names.";
        }

        if (request.Compose is { } compose)
        {
            if (string.IsNullOrWhiteSpace(compose))
            {
                return "The compose file is empty.";
            }

            if (Encoding.UTF8.GetByteCount(compose) > MaxComposeBytes || compose.Contains('\0', StringComparison.Ordinal))
            {
                return "The compose file is larger than 1 MB, or is not text.";
            }
        }

        return request.AcknowledgedRisks is { } risks && (risks.Length > StackRules.MaxAcknowledgments || !risks.All(StackRules.IsRiskId))
            ? $"Acknowledge at most {StackRules.MaxAcknowledgments} findings, by the ids the linter gave them."
            : string.Empty;
    }
}
