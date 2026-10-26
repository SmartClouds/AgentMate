using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Runova.ServerCore.Contracts;

namespace Runova.ServerCore.Firewall;

/// <summary>Whether a change set was kept or put back. Whichever is written first holds.</summary>
internal enum FirewallDecision
{
    Confirmed,
    Reverted,
}

/// <summary>How a revert went, written by whoever ran it (the timer's program or the core).</summary>
internal sealed record FirewallRevertResult(bool Restored, long AtUnixMs, string? Error, string[] Log);

internal enum FirewallRevertOutcome
{
    Restored,

    /// <summary>The change was confirmed first, so nothing was put back.</summary>
    AlreadyConfirmed,

    /// <summary>An earlier run put it back already.</summary>
    AlreadyReverted,

    Failed,
}

[JsonSerializable(typeof(FirewallRevertResult))]
[JsonSourceGenerationOptions(WriteIndented = true)]
internal sealed partial class FirewallRevertResultJson : JsonSerializerContext;

/// <summary>
/// The files of one change set, in a folder of its own under the core's state folder:
/// snapshot.json (the rules before the change), decision (confirmed or reverted) and result.json
/// (how a revert went). The decision file is created, never overwritten, so a confirmation and the
/// timer racing at the deadline cannot both win: the one that creates it decides.
/// </summary>
internal sealed class FirewallChangeFiles(string dataDirectory, Guid changeSetId)
{
    private const UnixFileMode OwnerOnly = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute;

    private static readonly UTF8Encoding _utf8 = new(encoderShouldEmitUTF8Identifier: false);

    public Guid ChangeSetId { get; } = changeSetId;

    /// <summary>Where every change set's folder lives.</summary>
    public static string Root(string dataDirectory) => Path.Combine(dataDirectory, "firewall");

    public string Folder => Path.Combine(Root(dataDirectory), ChangeSetId.ToString("N"));

    public string SnapshotPath => Path.Combine(Folder, "snapshot.json");

    public string DecisionPath => Path.Combine(Folder, "decision");

    public string ResultPath => Path.Combine(Folder, "result.json");

    public void WriteSnapshot(FirewallSnapshot snapshot)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        EnsureFolder();
        WriteDurably(SnapshotPath, JsonSerializer.Serialize(snapshot, FirewallSnapshotJson.Default.FirewallSnapshot), FileMode.Create);
    }

    public FirewallSnapshot? ReadSnapshot()
    {
        try
        {
            return JsonSerializer.Deserialize(File.ReadAllText(SnapshotPath), FirewallSnapshotJson.Default.FirewallSnapshot);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }
    }

    /// <summary>Records the decision unless one exists; returns the one that holds.</summary>
    public FirewallDecision Decide(FirewallDecision wanted)
    {
        EnsureFolder();
        try
        {
            WriteDurably(DecisionPath, wanted == FirewallDecision.Confirmed ? "confirmed\n" : "reverted\n", FileMode.CreateNew);
            return wanted;
        }
        catch (IOException) when (File.Exists(DecisionPath))
        {
            // Someone decided first. A decision file that cannot be read counts as reverted: the
            // timer's side is the safe one to take.
            return Decision() ?? FirewallDecision.Reverted;
        }
    }

    public FirewallDecision? Decision()
    {
        try
        {
            return File.ReadAllText(DecisionPath).Trim() switch
            {
                "confirmed" => FirewallDecision.Confirmed,
                "reverted" => FirewallDecision.Reverted,
                _ => FirewallDecision.Reverted,
            };
        }
        catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException)
        {
            return null;
        }
    }

    public void WriteResult(FirewallRevertResult result)
    {
        ArgumentNullException.ThrowIfNull(result);
        EnsureFolder();
        WriteDurably(ResultPath, JsonSerializer.Serialize(result, FirewallRevertResultJson.Default.FirewallRevertResult), FileMode.Create);
    }

    public FirewallRevertResult? ReadResult()
    {
        try
        {
            return JsonSerializer.Deserialize(File.ReadAllText(ResultPath), FirewallRevertResultJson.Default.FirewallRevertResult);
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

    /// <summary>Written and flushed to the disk before this returns: a power cut must not lose a decision.</summary>
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

/// <summary>
/// Puts a change set's saved rules back, unless it was confirmed first. The timer runs this
/// through the core's binary (runova-core firewall-revert), with no database and no core
/// needed; the core runs the same program when someone reverts by hand or a step fails.
/// </summary>
internal static class FirewallRevert
{
    public static async Task<FirewallRevertOutcome> RunAsync(
        FirewallChangeFiles files,
        Func<FirewallBackendKind, IFirewallBackend?> backends,
        TimeProvider time,
        Action<string> log,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(files);
        ArgumentNullException.ThrowIfNull(backends);
        ArgumentNullException.ThrowIfNull(time);
        ArgumentNullException.ThrowIfNull(log);

        if (files.Decide(FirewallDecision.Reverted) == FirewallDecision.Confirmed)
        {
            log("The change was confirmed, so there is nothing to put back.");
            return FirewallRevertOutcome.AlreadyConfirmed;
        }

        if (files.ReadResult() is { Restored: true })
        {
            log("The saved rules were put back already.");
            return FirewallRevertOutcome.AlreadyReverted;
        }

        var lines = new List<string>();
        void Log(string line)
        {
            lines.Add(line);
            log(line);
        }

        string? error = null;
        var snapshot = files.ReadSnapshot();
        var backend = snapshot is null ? null : backends(snapshot.Backend);
        if (snapshot is null)
        {
            error = "The saved rules for this change are missing or unreadable, so they cannot be put back.";
        }
        else if (backend is null)
        {
            error = $"The rules were saved from {snapshot.Backend}, which this server no longer has.";
        }
        else
        {
            try
            {
                Log($"Putting back the firewall rules saved before change {files.ChangeSetId:D}.");
                await backend.RestoreAsync(snapshot, Log, cancellationToken);
                Log("The saved rules are back.");
            }
            catch (Exception failure) when (failure is FirewallStepFailedException or FirewallRefusedException or IOException
                or UnauthorizedAccessException or Execution.ProcessStartException)
            {
                error = failure.Message;
            }
        }

        if (error is not null)
        {
            Log(error);
        }

        files.WriteResult(new FirewallRevertResult(error is null, time.GetUtcNow().ToUnixTimeMilliseconds(), error, [.. lines]));
        return error is null ? FirewallRevertOutcome.Restored : FirewallRevertOutcome.Failed;
    }
}
