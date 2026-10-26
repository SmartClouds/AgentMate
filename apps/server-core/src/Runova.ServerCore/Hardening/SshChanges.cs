using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.Hardening;

/// <summary>
/// One SSH change as written before anything on the server changes: the drop-in as it was (null
/// when there was none) and how to reload sshd, which is all the rollback needs.
/// </summary>
/// <param name="AppliedFrom">The SSH connection that applied it; a confirmation must come over another.</param>
internal sealed record SshChangeSnapshot(
    Guid Id,
    string Summary,
    string? PreviousContent,
    string ReloadUnit,
    string RequestedBy,
    string AppliedFrom,
    long CreatedAtUnixMs,
    long DeadlineUnixMs);

internal enum SshDecision
{
    Confirmed,
    Reverted,
}

/// <summary>Why a change went back.</summary>
internal enum SshRevertCause
{
    Timer,
    Manual,

    /// <summary>The change never took: sshd refused it, or it did not do what it should.</summary>
    Failed,
}

internal sealed record SshRevertResult(bool Restored, SshRevertCause Cause, long AtUnixMs, string? Error, string[] Log);

[JsonSerializable(typeof(SshChangeSnapshot))]
[JsonSerializable(typeof(SshRevertResult))]
[JsonSourceGenerationOptions(WriteIndented = true, UseStringEnumConverter = true)]
internal sealed partial class SshChangeJson : JsonSerializerContext;

/// <summary>
/// A change's folder under the core's state folder: snapshot.json, decision and result.json. The
/// decision file is created, never overwritten, so a confirmation and the timer racing at the
/// deadline cannot both win (as the firewall's change sets do).
/// </summary>
internal sealed class SshChangeFiles(string dataDirectory, Guid id)
{
    private const UnixFileMode OwnerOnly = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute;

    private static readonly UTF8Encoding _utf8 = new(encoderShouldEmitUTF8Identifier: false);

    public Guid Id { get; } = id;

    public static string Root(string dataDirectory) => Path.Combine(dataDirectory, "ssh-hardening");

    public string Folder => Path.Combine(Root(dataDirectory), Id.ToString("N"));

    private string SnapshotPath => Path.Combine(Folder, "snapshot.json");

    private string DecisionPath => Path.Combine(Folder, "decision");

    private string ResultPath => Path.Combine(Folder, "result.json");

    /// <summary>Every change written so far, newest first.</summary>
    public static IReadOnlyList<SshChangeFiles> All(string dataDirectory)
    {
        var root = Root(dataDirectory);
        if (!Directory.Exists(root))
        {
            return [];
        }

        return [.. Directory.EnumerateDirectories(root)
            .Select(folder => Guid.TryParseExact(Path.GetFileName(folder), "N", out var found) ? new SshChangeFiles(dataDirectory, found) : null)
            .OfType<SshChangeFiles>()
            .Select(files => (Files: files, Snapshot: files.ReadSnapshot()))
            .Where(entry => entry.Snapshot is not null)
            .OrderByDescending(entry => entry.Snapshot!.CreatedAtUnixMs)
            .Select(entry => entry.Files)];
    }

    public void WriteSnapshot(SshChangeSnapshot snapshot)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        EnsureFolder();
        WriteDurably(SnapshotPath, JsonSerializer.Serialize(snapshot, SshChangeJson.Default.SshChangeSnapshot), FileMode.Create);
    }

    public SshChangeSnapshot? ReadSnapshot() => Read(SnapshotPath, SshChangeJson.Default.SshChangeSnapshot);

    /// <summary>Records the decision unless one exists; returns the one that holds.</summary>
    public SshDecision Decide(SshDecision wanted)
    {
        EnsureFolder();
        try
        {
            WriteDurably(DecisionPath, wanted == SshDecision.Confirmed ? "confirmed\n" : "reverted\n", FileMode.CreateNew);
            return wanted;
        }
        catch (IOException) when (File.Exists(DecisionPath))
        {
            // Decided first by someone else. Unreadable counts as reverted, the safe side.
            return Decision() ?? SshDecision.Reverted;
        }
    }

    public SshDecision? Decision()
    {
        try
        {
            return File.ReadAllText(DecisionPath).Trim() == "confirmed" ? SshDecision.Confirmed : SshDecision.Reverted;
        }
        catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException)
        {
            return null;
        }
    }

    public void WriteResult(SshRevertResult result)
    {
        ArgumentNullException.ThrowIfNull(result);
        EnsureFolder();
        WriteDurably(ResultPath, JsonSerializer.Serialize(result, SshChangeJson.Default.SshRevertResult), FileMode.Create);
    }

    public SshRevertResult? ReadResult() => Read(ResultPath, SshChangeJson.Default.SshRevertResult);

    public SshHardeningChangeInfo? Info()
    {
        if (ReadSnapshot() is not { } snapshot)
        {
            return null;
        }

        var result = ReadResult();
        var state = Decision() switch
        {
            SshDecision.Confirmed => SshHardeningState.Confirmed,
            SshDecision.Reverted when result?.Cause == SshRevertCause.Failed => SshHardeningState.Failed,
            SshDecision.Reverted => SshHardeningState.RolledBack,
            _ => SshHardeningState.AwaitingConfirmation,
        };
        return new SshHardeningChangeInfo(
            snapshot.Id,
            state,
            snapshot.Summary,
            snapshot.CreatedAtUnixMs,
            snapshot.DeadlineUnixMs,
            snapshot.RequestedBy,
            result?.AtUnixMs,
            result?.Error);
    }

    private static T? Read<T>(string path, System.Text.Json.Serialization.Metadata.JsonTypeInfo<T> type)
        where T : class
    {
        try
        {
            return JsonSerializer.Deserialize(File.ReadAllText(path), type);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }
    }

    private void EnsureFolder()
    {
        foreach (var folder in new[] { Root(dataDirectory), Folder })
        {
            if (OperatingSystem.IsWindows())
            {
                Directory.CreateDirectory(folder);
                continue;
            }

            Directory.CreateDirectory(folder, OwnerOnly);
            if (File.GetUnixFileMode(folder) != OwnerOnly)
            {
                File.SetUnixFileMode(folder, OwnerOnly);
            }
        }
    }

    private static void WriteDurably(string path, string content, FileMode mode)
    {
        var options = new FileStreamOptions { Mode = mode, Access = FileAccess.Write, Share = FileShare.None };
        if (!OperatingSystem.IsWindows())
        {
            options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        }

        using var stream = new FileStream(path, options);
        stream.Write(_utf8.GetBytes(content));
        stream.Flush(flushToDisk: true);
    }
}

internal enum SshRevertOutcome
{
    Restored,
    AlreadyConfirmed,
    AlreadyReverted,
    Failed,
}

/// <summary>
/// Puts a change's old drop-in back and reloads sshd, unless the change was confirmed first. The
/// timer runs this through the core's binary (runova-core ssh-revert) with the core stopped or
/// not; the core runs the same code to revert by hand or when a step failed. A drop-in that would
/// leave sshd unable to load its configuration is removed instead: the revert must not be what
/// breaks SSH.
/// </summary>
internal static class SshRevert
{
    public static async Task<SshRevertOutcome> RunAsync(
        SshChangeFiles files,
        ISshMachine machine,
        SshRevertCause cause,
        TimeProvider time,
        CancellationToken cancellationToken,
        string? error = null)
    {
        ArgumentNullException.ThrowIfNull(files);
        ArgumentNullException.ThrowIfNull(machine);
        ArgumentNullException.ThrowIfNull(time);
        if (files.ReadSnapshot() is not { } snapshot)
        {
            return SshRevertOutcome.Failed;
        }

        if (files.Decide(SshDecision.Reverted) == SshDecision.Confirmed)
        {
            return SshRevertOutcome.AlreadyConfirmed;
        }

        if (files.ReadResult() is { Restored: true })
        {
            return SshRevertOutcome.AlreadyReverted;
        }

        var log = new List<string>();
        try
        {
            if (snapshot.PreviousContent is null)
            {
                machine.DeleteDropIn();
                log.Add($"Removed {SshdPolicy.DropInPath}.");
            }
            else
            {
                machine.WriteDropIn(snapshot.PreviousContent);
                log.Add($"Put the earlier {SshdPolicy.DropInPath} back.");
                if (await machine.TestAsync(cancellationToken) is { } complaint)
                {
                    machine.DeleteDropIn();
                    log.Add($"sshd refused the earlier file ({complaint}), so it was removed instead.");
                }
            }

            await machine.ReloadAsync(snapshot.ReloadUnit, cancellationToken);
            log.Add($"Reloaded {snapshot.ReloadUnit}.");
            files.WriteResult(new SshRevertResult(true, cause, time.GetUtcNow().ToUnixTimeMilliseconds(), error, [.. log]));
            return SshRevertOutcome.Restored;
        }
        catch (Exception failure) when (failure is IOException or UnauthorizedAccessException or Execution.ProcessFailedException or Execution.ProcessStartException)
        {
            var reason = error is null ? failure.Message : $"{error} Putting the old settings back failed too: {failure.Message}";
            files.WriteResult(new SshRevertResult(false, cause, time.GetUtcNow().ToUnixTimeMilliseconds(), reason, [.. log]));
            return SshRevertOutcome.Failed;
        }
    }
}
