using Runova.ServerCore.Contracts;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Hardening;

namespace Runova.ServerCore.Cli;

/// <summary>
/// `runova-core ssh-revert &lt;change id&gt; --data-directory &lt;path&gt;`: what an SSH change's
/// rollback timer runs. It puts the old sshd drop-in back and reloads sshd unless the change was
/// confirmed first, and needs nothing but the change's folder, so it works with the core stopped.
/// </summary>
internal static class SshRevertCommand
{
    public const string Name = "ssh-revert";

    private const string Usage = "Usage: runova-core ssh-revert <change id> --data-directory <absolute path>";

    public static Task<int> RunAsync(string[] args, TextWriter output, TextWriter error) =>
        // The reload unit comes from the change's snapshot, so the family here does not matter.
        RunAsync(args, output, error, new LinuxSshMachine(new ProcessRunner(TimeProvider.System), OsFamily.Debian), TimeProvider.System);

    /// <summary>For tests: the same, with the machine and clock handed in.</summary>
    public static async Task<int> RunAsync(string[] args, TextWriter output, TextWriter error, ISshMachine machine, TimeProvider time)
    {
        ArgumentNullException.ThrowIfNull(args);
        ArgumentNullException.ThrowIfNull(output);
        ArgumentNullException.ThrowIfNull(error);

        if (args is not [Name, var idText, "--data-directory", var directory]
            || !Guid.TryParse(idText, out var id)
            || !(directory.StartsWith('/') || Path.IsPathFullyQualified(directory)))
        {
            await error.WriteLineAsync(Usage);
            return 2;
        }

        var files = new SshChangeFiles(directory, id);
        var outcome = await SshRevert.RunAsync(files, machine, SshRevertCause.Timer, time, CancellationToken.None);
        foreach (var line in files.ReadResult()?.Log ?? [])
        {
            await output.WriteLineAsync(line);
        }

        switch (outcome)
        {
            case SshRevertOutcome.Failed:
                await error.WriteLineAsync($"SSH change {id:D}: the old settings could not be put back. {files.ReadResult()?.Error}");
                return 1;
            case SshRevertOutcome.Restored:
                await output.WriteLineAsync($"SSH change {id:D}: the old settings are back.");
                return 0;
            default:
                return 0;
        }
    }
}
