using Tapper;

namespace Runova.ServerCore.Contracts;

// The Deploy AI and the logs center (E09). StreamExec is the core's one shell entry point: Admins
// only, every run audited. A command runs unattended only when it is on the read-only allowlist;
// anything else needs an approval the user's device signed over the exact command text and a
// single-use nonce from NewExecApproval. A command from the assistant also needs the session's
// "auto-run diagnostics" mode on to run unattended.

[TranspilationSource]
public enum AssistantMode
{
    /// <summary>Every command waits for the user's approval. The default.</summary>
    ApproveEveryCommand,

    /// <summary>Read-only diagnostics on the allowlist run without asking; anything else still waits.</summary>
    AutoRunDiagnostics,
}

/// <summary>The session's mode, and the commands the allowlist knows, for the app to show.</summary>
[TranspilationSource]
public sealed record AssistantModeInfo(AssistantMode Mode, string[] Allowlist);

/// <summary>
/// A nonce to sign once, within ExpiresAtUnixMs, for one command on this session. The message is
/// "runova-core/exec/v1", NonceId, Nonce, the device id, the session id and the command, one
/// per line in that order, signed with the device's key (ECDSA P-256, SHA-256, r||s).
/// </summary>
[TranspilationSource]
public sealed record ExecApprovalNonce(Guid NonceId, string Nonce, long ExpiresAtUnixMs);

/// <summary>Signature is base64.</summary>
[TranspilationSource]
public sealed record ExecApproval(Guid NonceId, string Signature);

/// <summary>
/// A command for the server's shell. TimeoutSeconds is 1 to 600 (60 by default). FromAssistant
/// marks a step the Deploy AI proposed, which the audit trail records as such.
/// </summary>
[TranspilationSource]
public sealed record ExecRequest(
    string Command,
    string? WorkingDirectory = null,
    int? TimeoutSeconds = null,
    bool FromAssistant = false,
    ExecApproval? Approval = null);

[TranspilationSource]
public enum ExecOutputSource
{
    Out,
    Err,
}

/// <summary>A line the command wrote, redacted.</summary>
[TranspilationSource]
public sealed record ExecLine(ExecOutputSource Stream, string Text);

/// <summary>
/// Output as it comes, in batches. The last item has Ended set with the exit code (null when the
/// command was stopped) and whether it ran out of time. Truncated says lines were left out past
/// the output cap.
/// </summary>
[TranspilationSource]
public sealed record ExecOutput(
    ExecLine[] Lines,
    bool Ended = false,
    int? ExitCode = null,
    bool TimedOut = false,
    bool Truncated = false);

/// <summary>
/// A systemd unit's journal: the last Lines lines (200 by default, at most 2000), from SinceUnixMs
/// when given, then new ones while Follow is on.
/// </summary>
[TranspilationSource]
public sealed record JournalRequest(string Unit, int? Lines = null, long? SinceUnixMs = null, bool Follow = true);

/// <summary>Priority is syslog's: 0 emergency to 7 debug. Text is redacted; show it as text only.</summary>
[TranspilationSource]
public sealed record JournalLine(long AtUnixMs, int Priority, string Text);

[TranspilationSource]
public sealed record JournalBatch(JournalLine[] Lines);
