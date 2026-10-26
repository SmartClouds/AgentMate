using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Runova.ServerCore.Backups;
using Runova.ServerCore.Compatibility;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Hardening;
using Runova.ServerCore.Hosting;
using Runova.ServerCore.Web;

namespace Runova.ServerCore.Updates;

/// <summary>
/// Whether the move runs at start. The test core and the DevHost turn it off: they run on machines
/// the core does not manage, and the move would read and rename that machine's sshd drop-in.
/// </summary>
internal sealed record LegacyNamesMoveOptions(bool RunInBackground = true)
{
    public static LegacyNamesMoveOptions Default { get; } = new();
}

/// <summary>How the moves of nginx and the sshd drop-in to the new names went, as last recorded.</summary>
internal sealed record NameMoves(NameMoveStatus? Nginx = null, NameMoveStatus? Sshd = null);

/// <summary>The record of the name moves in the core's state folder, root only.</summary>
internal sealed class NameMovesFile(string path)
{
    private static readonly JsonSerializerOptions _json = new(CoreJson.Options) { WriteIndented = true };

    public string Path { get; } = path;

    public NameMoves Read()
    {
        try
        {
            return File.Exists(Path) ? JsonSerializer.Deserialize<NameMoves>(File.ReadAllText(Path), _json) ?? new NameMoves() : new NameMoves();
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException)
        {
            return new NameMoves();
        }
    }

    public void Write(NameMoves moves)
    {
        var temporary = Path + ".new";
        var options = new FileStreamOptions { Mode = FileMode.Create, Access = FileAccess.Write };
        if (!OperatingSystem.IsWindows())
        {
            options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        }

        using (var stream = new FileStream(temporary, options))
        {
            JsonSerializer.Serialize(stream, moves, _json);
        }

        File.Move(temporary, Path, overwrite: true);
    }

    /// <summary>Why the nginx move was put back, while nginx still has its old names.</summary>
    public string? NginxError() => Read().Nginx is { Phase: NameMovePhase.Failed } nginx ? nginx.Detail : null;
}

/// <summary>
/// Renames the sshd drop-in a server got before the rename to the new name, but only when sshd
/// reads the same settings either way. The name decides where the file sorts among the others in
/// sshd_config.d, and sshd takes the first value it reads for a keyword, so another file that
/// sorts between the two names could win where it lost before. `sshd -T` before and after must
/// match and `sshd -t` must pass; otherwise the file goes back to its old name, which the core
/// keeps managing (SshdPolicy.DropInPath).
/// </summary>
internal sealed class SshdDropInMove(IProcessRunner runner, string legacyPath, string newPath)
{
    public async Task<NameMoveStatus> RunAsync(bool sshChangePending, CancellationToken cancellationToken)
    {
        if (!File.Exists(legacyPath))
        {
            return new NameMoveStatus(File.Exists(newPath) ? NameMovePhase.Done : NameMovePhase.NotNeeded);
        }

        if (File.Exists(newPath))
        {
            return new NameMoveStatus(NameMovePhase.Kept, $"{newPath} is there as well, so {legacyPath} keeps its name.");
        }

        if (sshChangePending)
        {
            return new NameMoveStatus(NameMovePhase.Waiting, "An SSH change waits to be confirmed; the drop-in is renamed once it is settled.");
        }

        var before = await SshdAsync("-T", cancellationToken);
        if (!before.Succeeded)
        {
            return new NameMoveStatus(NameMovePhase.Kept, $"sshd -T failed, so the drop-in keeps its old name: {Reason(before)}");
        }

        File.Move(legacyPath, newPath);
        var test = await SshdAsync("-t", cancellationToken);
        var after = test.Succeeded ? await SshdAsync("-T", cancellationToken) : test;
        if (test.Succeeded && after.Succeeded && after.StandardOutput == before.StandardOutput)
        {
            return new NameMoveStatus(NameMovePhase.Done);
        }

        File.Move(newPath, legacyPath);
        return new NameMoveStatus(
            NameMovePhase.Kept,
            !test.Succeeded
                ? $"sshd -t refused the drop-in under its new name, so it keeps its old one: {Reason(test)}"
                : "sshd would read different settings with the drop-in under its new name (another file sorts between the two names), so it keeps its old one.");
    }

    private async Task<ProcessResult> SshdAsync(string flag, CancellationToken cancellationToken)
    {
        try
        {
            return await runner.RunAsync(new ProcessSpec { Program = "sshd", Arguments = [flag], Timeout = TimeSpan.FromSeconds(30) }, onLine: null, cancellationToken);
        }
        catch (ProcessStartException missing)
        {
            return new ProcessResult(127, string.Empty, missing.Message, TimedOut: false, OutputTruncated: false);
        }
    }

    private static string Reason(ProcessResult result) =>
        (result.StandardError.Trim() is { Length: > 0 } error ? error : result.StandardOutput.Trim()) is { Length: > 0 } text
            ? text.Split('\n')[0]
            : $"exit code {result.ExitCode}";
}

/// <summary>
/// Once the core runs in the Runova layout: moves nginx and the sshd drop-in of a server set up
/// before the rename to the new names, at every start until each is done (a move that fails is
/// put back, so trying again on the next start is safe). It runs after the core has started, not
/// as part of its start: the core answers meanwhile, and a slow nginx never holds it up.
/// </summary>
internal sealed partial class LegacyNamesMove(
    CoreLayout layout,
    WebSites sites,
    IProcessRunner runner,
    CoreDirectories directories,
    IDbContextFactory<CoreDbContext> contexts,
    NameMovesFile record,
    LegacyNamesMoveOptions options,
    ILogger<NginxNameMove> moveLogger,
    ILogger<LegacyNamesMove> logger) : BackgroundService
{
    public const string NginxJournalName = "nginx-move.json";

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (layout.Kind != CoreLayoutKind.Runova || !options.RunInBackground)
        {
            return;
        }

        try
        {
            await RunAsync(stoppingToken);
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            LogFailed(logger, error);
        }
    }

    public async Task<NameMoves> RunAsync(CancellationToken cancellationToken)
    {
        var moves = record.Read();
        var sshd = await MoveSshdAsync(cancellationToken);
        var nginx = moves.Nginx?.Phase == NameMovePhase.Done
            ? moves.Nginx
            : await sites.MoveToNewNamesAsync(Path.Combine(directories.Data, NginxJournalName), moveLogger, cancellationToken);
        var now = new NameMoves(nginx, sshd);
        if (now != moves && (now.Nginx?.Phase != NameMovePhase.NotNeeded || now.Sshd?.Phase != NameMovePhase.NotNeeded || File.Exists(record.Path)))
        {
            record.Write(now);
        }

        return now;
    }

    private async Task<NameMoveStatus> MoveSshdAsync(CancellationToken cancellationToken)
    {
        if (!OperatingSystem.IsLinux())
        {
            return new NameMoveStatus(NameMovePhase.NotNeeded);
        }

        bool pending;
        await using (var db = await contexts.CreateDbContextAsync(cancellationToken))
        {
            pending = (await RestoreGuard.PendingAsync(directories.Data, db, cancellationToken))
                .Any(change => change.StartsWith("SSH change", StringComparison.Ordinal));
        }

        return await new SshdDropInMove(runner, LegacyNames.SshdDropInPath, SshdPolicy.RunovaDropInPath).RunAsync(pending, cancellationToken);
    }

    [LoggerMessage(Level = LogLevel.Error, Message = "Moving nginx and the sshd drop-in to the Runova names failed.")]
    private static partial void LogFailed(ILogger logger, Exception error);
}
