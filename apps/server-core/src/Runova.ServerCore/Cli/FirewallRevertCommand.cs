using Runova.ServerCore.Contracts;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Firewall;
using Runova.ServerCore.Platform;

namespace Runova.ServerCore.Cli;

/// <summary>
/// `runova-core firewall-revert &lt;change set id&gt; --data-directory &lt;path&gt;`: what the
/// rollback timer runs. It puts the change set's saved rules back unless the change was confirmed
/// first, and needs nothing but the change set's folder, so it works with the core stopped. It
/// runs in a transient unit of its own, so it runs the firewall's programs directly.
/// </summary>
internal static class FirewallRevertCommand
{
    public const string Name = "firewall-revert";

    private const string Usage = "Usage: runova-core firewall-revert <change set id> --data-directory <absolute path>";

    public static Task<int> RunAsync(string[] args, TextWriter output, TextWriter error)
    {
        var runner = new ProcessRunner(TimeProvider.System);
        var commands = new DirectCommands(runner);
        var files = new SystemFiles();
        return RunAsync(args, output, error, kind => FirewallBackends.Create(kind, runner, commands, files), TimeProvider.System);
    }

    /// <summary>For tests: the same, with the backends and clock handed in.</summary>
    public static async Task<int> RunAsync(
        string[] args,
        TextWriter output,
        TextWriter error,
        Func<FirewallBackendKind, IFirewallBackend?> backends,
        TimeProvider time)
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

        var files = new FirewallChangeFiles(directory, id);
        var lines = new List<string>();
        var outcome = await FirewallRevert.RunAsync(files, backends, time, lines.Add, CancellationToken.None);
        foreach (var line in lines)
        {
            await output.WriteLineAsync(line);
        }

        switch (outcome)
        {
            case FirewallRevertOutcome.Failed:
                await error.WriteLineAsync($"Change {id:D}: the saved rules could not be put back. {files.ReadResult()?.Error}");
                return 1;
            case FirewallRevertOutcome.Restored:
                await output.WriteLineAsync($"Change {id:D}: the saved rules were put back.");
                return 0;
            default:
                return 0;
        }
    }
}
