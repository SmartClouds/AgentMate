namespace Runova.ServerCore.Cli;

/// <summary>
/// One binary serves the API, answers the installer's admin commands, bridges stdio to the socket,
/// rolls back an unconfirmed firewall or SSH change (what their timers run) and moves a server to
/// the Runova layout. Only an exact "admin", "bridge", "firewall-revert", "ssh-revert" or
/// "migrate-layout" first argument leaves the web host path: the test
/// factory and other tooling call the entry point with arguments of their own, and those must
/// always reach the host.
/// </summary>
internal static class CoreEntryPoint
{
    public static Task<int> RunAsync(
        string[] args,
        TextWriter output,
        TextWriter error,
        Func<string[], Task<int>> serve)
    {
        ArgumentNullException.ThrowIfNull(args);
        ArgumentNullException.ThrowIfNull(serve);

        return args switch
        {
            ["admin", .. var command] => AdminCli.RunAsync(command, output, error),
            ["bridge", .. var bridgeArgs] => BridgeCommand.RunAsync(
                bridgeArgs,
                Console.OpenStandardInput(),
                Console.OpenStandardOutput(),
                error,
                CancellationToken.None),
            [FirewallRevertCommand.Name, ..] => FirewallRevertCommand.RunAsync(args, output, error),
            [SshRevertCommand.Name, ..] => SshRevertCommand.RunAsync(args, output, error),
            [MigrateLayoutCommand.Name, ..] => MigrateLayoutCommand.RunAsync(args, output, error),
            ["serve", .. var hostArgs] => serve(hostArgs),
            _ => serve(args),
        };
    }
}
