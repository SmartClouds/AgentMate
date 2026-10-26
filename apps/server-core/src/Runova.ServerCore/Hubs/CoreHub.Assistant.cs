using System.Globalization;
using System.Runtime.CompilerServices;
using System.Threading.Channels;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Runova.ServerCore.Assistant;
using Runova.ServerCore.Audit;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Hubs;

/// <summary>
/// The Deploy AI's shell and the logs center's journal (E09), for Admins. StreamExec decides on
/// its own what may run: a command on the read-only allowlist runs unattended (an assistant's only
/// in a session that turned "auto-run diagnostics" on, which takes a step-up); anything else needs
/// an approval signed by this session's device over the exact command and a fresh nonce. Every
/// run and every refusal lands in the audit trail, and every line of output is redacted with the
/// server's env values before it leaves the core.
/// </summary>
internal sealed partial class CoreHub
{
    public const string ExecNeedsApproval = "This command needs your approval before it runs.";

    public const string ExecApprovalInvalid = "The approval for this command is not valid. Approve it again.";

    private const int MaxExecCommand = 4_096;
    private const int MaxExecLines = 5_000;
    private const int MaxExecBytes = 1024 * 1024;
    private const int ExecBatch = 200;
    private const int DefaultExecSeconds = 60;
    private const int MaxExecSeconds = 600;

    [Authorize(Policy = CorePolicies.Admin)]
    public Task<AssistantModeInfo> GetAssistantMode() => Task.FromResult(ModeInfo());

    [Authorize(Policy = CorePolicies.Admin)]
    [Authorize(Policy = CorePolicies.StepUp)]
    public async Task<AssistantModeInfo> EnableAutoRunDiagnostics()
    {
        assistant.Modes.Set(SessionId, autoRun: true);
        await AuditAsync("assistant.mode", AuditResult.Success, parameters: new() { ["mode"] = nameof(AssistantMode.AutoRunDiagnostics) });
        return ModeInfo();
    }

    [Authorize(Policy = CorePolicies.Admin)]
    public async Task<AssistantModeInfo> DisableAutoRunDiagnostics()
    {
        assistant.Modes.Set(SessionId, autoRun: false);
        await AuditAsync("assistant.mode", AuditResult.Success, parameters: new() { ["mode"] = nameof(AssistantMode.ApproveEveryCommand) });
        return ModeInfo();
    }

    [Authorize(Policy = CorePolicies.Admin)]
    public Task<ExecApprovalNonce> NewExecApproval()
    {
        var issued = assistant.Approvals.Issue(SessionId, DeviceId)
            ?? throw new HubException("Too many approvals are waiting. Approve or skip the ones open first.");
        return Task.FromResult(new ExecApprovalNonce(issued.Id, issued.Nonce, issued.ExpiresAt));
    }

    [Authorize(Policy = CorePolicies.Admin)]
    public async IAsyncEnumerable<ExecOutput> StreamExec(
        ExecRequest request,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        using var lease = server.Streams.Open(Context.ConnectionId, StreamLimits.Exec);
        var command = request?.Command;
        if (string.IsNullOrWhiteSpace(command) || command.Length > MaxExecCommand || command.Contains('\0', StringComparison.Ordinal))
        {
            throw new HubException($"A command is 1 to {MaxExecCommand} characters.");
        }

        var directory = request!.WorkingDirectory;
        if (directory is not null && (!directory.StartsWith('/') || directory.Length > 512 || directory.Any(char.IsControl)))
        {
            throw new HubException("The working folder is an absolute path.");
        }

        if (request.TimeoutSeconds is < 1 or > MaxExecSeconds)
        {
            throw new HubException($"A command may run for 1 to {MaxExecSeconds} seconds.");
        }

        var seeded = await assistant.Secrets.RedactorAsync(cancellationToken);
        var shown = seeded.Redact(command);
        var words = CommandAllowlist.Parse(command);
        var timeout = TimeSpan.FromSeconds(request.TimeoutSeconds ?? DefaultExecSeconds);
        var id = Guid.NewGuid();
        var parameters = new Dictionary<string, string?>
        {
            ["command"] = shown.Length > 1_000 ? shown[..1_000] : shown,
            ["assistant"] = request.FromAssistant ? "true" : "false",
        };

        ExecPlan plan;
        if (request.Approval is { } approval)
        {
            var key = await db.Devices.AsNoTracking()
                .Where(d => d.Id == DeviceId && d.RevokedAt == null)
                .Select(d => d.PublicKey)
                .FirstOrDefaultAsync(cancellationToken);
            if (key is null || !assistant.Approvals.Verify(approval.NonceId, approval.Signature, SessionId, DeviceId, key, command))
            {
                parameters["approval"] = "invalid";
                await AuditAsync("exec.run", AuditResult.Denied, parameters: parameters);
                throw new HubException(ExecApprovalInvalid);
            }

            parameters["approval"] = "signed";
            plan = ExecPlan.Approved(id, command, directory, timeout);
        }
        else if (words is not null && (!request.FromAssistant || assistant.Modes.AutoRuns(SessionId)))
        {
            parameters["approval"] = "allowlist";
            plan = ExecPlan.Allowlisted(id, words, directory, timeout);
        }
        else
        {
            parameters["approval"] = "none";
            await AuditAsync("exec.run", AuditResult.Denied, parameters: parameters);
            throw new HubException(ExecNeedsApproval);
        }

        await AuditAsync("exec.run", AuditResult.Success, id.ToString("N"), parameters);
        var lines = Channel.CreateBounded<ExecLine>(new BoundedChannelOptions(4_096) { SingleReader = true });
        var budget = new ExecBudget();
        var running = RunExecAsync(plan, seeded, lines.Writer, budget, cancellationToken);
        ProcessResult? result;
        var finished = false;
        try
        {
            await foreach (var batch in AssistantServices.BatchesAsync(lines.Reader, ExecBatch, cancellationToken))
            {
                yield return new ExecOutput(batch);
            }

            result = await running;
            finished = true;
        }
        finally
        {
            if (!finished)
            {
                // The app stopped it (or the connection went): the unit is stopped before this records it.
                await running.ContinueWith(_ => { }, CancellationToken.None, TaskContinuationOptions.None, TaskScheduler.Default);
                await AuditAsync("exec.exit", AuditResult.Cancelled, id.ToString("N"));
            }
        }

        await AuditAsync(
            "exec.exit",
            result is null ? AuditResult.Failed : AuditResult.Success,
            id.ToString("N"),
            new()
            {
                ["exit"] = result?.ExitCode.ToString(CultureInfo.InvariantCulture),
                ["timedOut"] = result?.TimedOut == true ? "true" : "false",
            });
        yield return new ExecOutput(
            [],
            Ended: true,
            ExitCode: result is null || result.TimedOut ? null : result.ExitCode,
            TimedOut: result?.TimedOut == true,
            Truncated: budget.Truncated);
    }

    [Authorize(Policy = CorePolicies.Admin)]
    public async IAsyncEnumerable<JournalBatch> StreamJournal(
        JournalRequest request,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        using var lease = server.Streams.Open(Context.ConnectionId, StreamLimits.Journal);
        if (!JournalUnits.IsUnit(request?.Unit))
        {
            throw new HubException("Name a systemd unit, as systemctl lists it (docker.service, nginx, ssh).");
        }

        if (request!.Lines is < 0 or > JournalUnits.MaxLines)
        {
            throw new HubException($"Ask for 0 to {JournalUnits.MaxLines} lines.");
        }

        if (request.SinceUnixMs is < 0)
        {
            throw new HubException("SinceUnixMs is a time in unix milliseconds.");
        }

        var seeded = await assistant.Secrets.RedactorAsync(cancellationToken);
        var query = new JournalQuery(request.Unit, request.Lines ?? JournalUnits.DefaultLines, request.SinceUnixMs, request.Follow);
        var lines = Channel.CreateBounded<JournalLine>(new BoundedChannelOptions(4_096) { FullMode = BoundedChannelFullMode.DropOldest });
        var reading = Task.Run(
            async () =>
            {
                try
                {
                    await foreach (var line in assistant.Journal.ReadAsync(query, cancellationToken))
                    {
                        lines.Writer.TryWrite(line with { Text = seeded.Redact(line.Text) });
                    }

                    lines.Writer.TryComplete();
                }
                catch (Exception error)
                {
                    lines.Writer.TryComplete(error);
                }
            },
            CancellationToken.None);
        await foreach (var batch in AssistantServices.BatchesAsync(lines.Reader, ExecBatch, cancellationToken))
        {
            yield return new JournalBatch(batch);
        }

        await reading;
    }

    private AssistantModeInfo ModeInfo() => new(
        assistant.Modes.AutoRuns(SessionId) ? AssistantMode.AutoRunDiagnostics : AssistantMode.ApproveEveryCommand,
        CommandAllowlist.Summary);

    /// <summary>
    /// Runs the plan, writing redacted lines until the output cap, and returns the result, or null
    /// when the command could not start. A cancelled run (the app stopped it) ends its unit and
    /// throws, as the stream does.
    /// </summary>
    private async Task<ProcessResult?> RunExecAsync(
        ExecPlan plan,
        Redactor seeded,
        ChannelWriter<ExecLine> lines,
        ExecBudget budget,
        CancellationToken cancellationToken)
    {
        try
        {
            return await assistant.Runner.RunAsync(
                plan,
                line =>
                {
                    if (!budget.Take(line.Text) || !lines.TryWrite(new ExecLine(line.Stream == OutputStream.Err ? ExecOutputSource.Err : ExecOutputSource.Out, seeded.Redact(line.Text))))
                    {
                        budget.Truncated = true;
                    }
                },
                cancellationToken);
        }
        catch (ProcessStartException missing)
        {
            lines.TryWrite(new ExecLine(ExecOutputSource.Err, seeded.Redact(missing.Message)));
            return null;
        }
        finally
        {
            lines.TryComplete();
        }
    }

    /// <summary>How much output a command may still send: a line and byte count.</summary>
    private sealed class ExecBudget
    {
        private int _lines;
        private long _bytes;

        public bool Truncated { get; set; }

        public bool Take(string text)
        {
            if (Truncated || _lines >= MaxExecLines || _bytes + text.Length > MaxExecBytes)
            {
                return false;
            }

            _lines++;
            _bytes += text.Length;
            return true;
        }
    }
}
