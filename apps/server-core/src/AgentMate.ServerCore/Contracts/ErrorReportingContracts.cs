using Tapper;

namespace AgentMate.ServerCore.Contracts;

// Error reporting (E29): the core sends its own warnings and errors to a Sentry project as
// OpenTelemetry logs. A person gives the server a DSN; the core keeps it sealed, never returns it,
// scrubs secrets out of every message before it leaves, and applies changes at once with no restart.

/// <summary>
/// How error reporting stands. Host and ProjectId say where logs go (never the key). MinLevel is
/// "warning" (warnings and errors) or "error" (errors only). Times are Unix milliseconds. LastError is
/// the last thing that went wrong when sending, in words for a person, until the next delivery works.
/// DefaultServerName is the machine's own name, for the app to offer as a starting point.
/// </summary>
[TranspilationSource]
public sealed record ErrorReportingStatus(
    bool Configured,
    bool Enabled,
    string? Host,
    string? ProjectId,
    string Environment,
    string ServerName,
    string MinLevel,
    string DefaultServerName,
    long SentCount,
    long? LastSentAtUnixMs = null,
    long? LastFailedAtUnixMs = null,
    string? LastError = null,
    long? ChangedAtUnixMs = null,
    string? ChangedBy = null);

/// <summary>
/// Sets error reporting up (Owner, with a step-up). Leave Dsn out to keep the one already stored, so
/// the level or environment can change without pasting the key again. An empty Environment means
/// "production", an empty ServerName the machine's name, and an empty MinLevel "warning".
/// </summary>
[TranspilationSource]
public sealed record ErrorReportingRequest(string? Dsn, bool Enabled, string? Environment, string? ServerName, string? MinLevel)
{
    public override string ToString() =>
        $"ErrorReportingRequest {{ Dsn = {(string.IsNullOrWhiteSpace(Dsn) ? "[none]" : "[redacted]")}, Enabled = {Enabled}, Environment = {Environment}, ServerName = {ServerName}, MinLevel = {MinLevel} }}";
}

/// <summary>Saved when Problems is empty (Status then says how it stands); otherwise nothing was saved.</summary>
[TranspilationSource]
public sealed record ErrorReportingSaveResult(string[] Problems, ErrorReportingStatus? Status = null);

/// <summary>
/// The outcome of a test event. Delivered says Sentry accepted it; HttpStatus is its answer when it
/// gave one; Message says what happened in words for a person.
/// </summary>
[TranspilationSource]
public sealed record ErrorReportingTestResult(bool Delivered, int? HttpStatus, string Message);
