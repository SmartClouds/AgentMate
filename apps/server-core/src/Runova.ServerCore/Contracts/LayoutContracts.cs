using Tapper;

namespace Runova.ServerCore.Contracts;

/// <summary>
/// Which installed layout a core runs in. Servers set up before the rename (release 1.63 and
/// older) are on the legacy one until they migrate; new installs start on the Runova one.
/// </summary>
[TranspilationSource]
public enum CoreLayoutName
{
    Legacy,
    Runova,
}

/// <summary>Where a layout migration is.</summary>
[TranspilationSource]
public enum LayoutMigrationPhase
{
    /// <summary>None was started on this server.</summary>
    None,

    /// <summary>It is under way: the core is about to stop, or has stopped and is moving.</summary>
    Running,

    /// <summary>The server runs in the Runova layout.</summary>
    Done,

    /// <summary>A step failed and everything was put back; Error says why.</summary>
    RolledBack,

    /// <summary>A step failed and so did putting it back. The server needs a look over SSH.</summary>
    Failed,
}

/// <param name="Layout">The layout this core runs in now.</param>
/// <param name="Phase">The last migration's phase, None when there was none.</param>
/// <param name="Step">The step it is on (or stopped at), in words.</param>
/// <param name="Error">Why it was rolled back or failed.</param>
/// <param name="StartedAtUnixMs">When it started.</param>
/// <param name="FinishedAtUnixMs">When it ended, either way.</param>
[TranspilationSource]
public sealed record LayoutMigrationStatus(
    CoreLayoutName Layout,
    LayoutMigrationPhase Phase,
    string? Step = null,
    string? Error = null,
    long? StartedAtUnixMs = null,
    long? FinishedAtUnixMs = null);

/// <summary>What asking for a migration did.</summary>
[TranspilationSource]
public enum LayoutMigrationOutcome
{
    /// <summary>It starts a few seconds from now, in a unit of its own; the core restarts under the new name.</summary>
    Started,

    /// <summary>The core already runs in the Runova layout.</summary>
    AlreadyMigrated,

    /// <summary>It cannot start now; Problem says why.</summary>
    Refused,
}

/// <param name="Outcome">What happened.</param>
/// <param name="Problem">Why it was refused, in words for the user.</param>
[TranspilationSource]
public sealed record LayoutMigrationResult(LayoutMigrationOutcome Outcome, string? Problem = null);
