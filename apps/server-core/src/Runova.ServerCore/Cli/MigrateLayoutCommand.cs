using System.Net.Http.Json;
using System.Net.Sockets;
using Microsoft.Extensions.Logging.Abstractions;
using Runova.ServerCore.Backups;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Endpoints;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Hosting;
using Runova.ServerCore.Updates;

namespace Runova.ServerCore.Cli;

/// <summary>
/// `runova-core migrate-layout [--resume | --rollback]`: moves a server from the legacy layout to
/// the Runova one (Updates/LayoutMigration.cs). It stops the core it moves, so it never runs
/// inside the core's own unit: started any other way (over SSH, from a shell) it starts itself
/// again in a transient unit of its own and relays what that prints. The unit carries on if the
/// SSH session ends; the journal records how far it got.
/// </summary>
internal static class MigrateLayoutCommand
{
    public const string Name = "migrate-layout";

    /// <summary>Set inside the transient unit, to the unit's name; its absence means "start the unit first".</summary>
    public const string UnitVariable = "RUNOVA_MIGRATION_UNIT";

    private const string Usage = "Usage: runova-core migrate-layout [--resume | --rollback]";

    public static async Task<int> RunAsync(string[] args, TextWriter output, TextWriter error)
    {
        ArgumentNullException.ThrowIfNull(args);
        ArgumentNullException.ThrowIfNull(output);
        ArgumentNullException.ThrowIfNull(error);
        string? mode = args switch
        {
            [Name] => null,
            [Name, "--resume"] => "--resume",
            [Name, "--rollback"] => "--rollback",
            _ => "usage",
        };
        if (mode == "usage")
        {
            await error.WriteLineAsync(Usage);
            return (int)LayoutMigrationExit.Refused;
        }

        if (!OperatingSystem.IsLinux() || Environment.UserName != "root" || Environment.ProcessPath is not { } self)
        {
            await error.WriteLineAsync("migrate-layout runs on the server, as root.");
            return (int)LayoutMigrationExit.Refused;
        }

        var runner = new ProcessRunner(TimeProvider.System);
        if (Environment.GetEnvironmentVariable(UnitVariable) is not { Length: > 0 } unit)
        {
            return await InUnitAsync(runner, self, mode, output);
        }

        var migration = new LayoutMigrationRunner(
            runner,
            new LayoutMigrationJournalFile(LayoutMigrationPlan.JournalPath),
            TimeProvider.System,
            cancellationToken => AnswersAsync(CoreLayout.Runova.SocketPath, cancellationToken),
            PendingChangesAsync,
            output)
        {
            OwnUnit = unit,
        };
        var exit = mode switch
        {
            "--resume" => await migration.ResumeAsync(CancellationToken.None),
            "--rollback" => await migration.RollbackAsync(CancellationToken.None),
            _ => CoreLayout.Current.Kind == CoreLayoutKind.Runova
                ? AlreadyMoved(output)
                : await migration.StartAsync(Path.GetDirectoryName(self)!, CancellationToken.None),
        };
        return (int)exit;
    }

    /// <summary>The same command in a transient unit, waited for, with its output passed on.</summary>
    private static async Task<int> InUnitAsync(IProcessRunner runner, string self, string? mode, TextWriter output)
    {
        var unit = SystemdRunner.UnitName("migrate", Guid.NewGuid());
        var units = new SystemdRunner(runner, TimeProvider.System, NullLogger<SystemdRunner>.Instance);
        var result = await units.RunAsync(
            unit,
            "Move the server core to the Runova layout",
            new ProcessSpec
            {
                Program = self,
                Arguments = mode is null ? [Name] : [Name, mode],
                Environment = new Dictionary<string, string>(StringComparer.Ordinal) { [UnitVariable] = unit },
                Timeout = TimeSpan.FromMinutes(30),
            },
            line =>
            {
                try
                {
                    output.WriteLine(line.Text);
                }
                catch (IOException)
                {
                    // The caller went away; the unit carries on.
                }
            },
            CancellationToken.None);
        return result.TimedOut ? (int)LayoutMigrationExit.Failed : result.ExitCode;
    }

    private static LayoutMigrationExit AlreadyMoved(TextWriter output)
    {
        output.WriteLine("This server core runs in the Runova layout already.");
        return LayoutMigrationExit.Done;
    }

    /// <summary>Firewall and SSH changes still waiting for a confirmation: their revert timers name the old paths.</summary>
    private static async Task<IReadOnlyList<string>> PendingChangesAsync(CancellationToken cancellationToken)
    {
        var environment = AdminEnvironment.FromSystem();
        await using var services = AdminCli.BuildServices(environment);
        await using var scope = services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<CoreDbContext>();
        try
        {
            return await RestoreGuard.PendingAsync(environment.DataDirectory, db, cancellationToken);
        }
        finally
        {
            CoreDatabase.ReleasePool(CoreDatabase.PathIn(environment.DataDirectory));
        }
    }

    /// <summary>Whether a core answers the health route on <paramref name="socketPath"/>, in the Runova layout.</summary>
    public static async Task<bool> AnswersAsync(string socketPath, CancellationToken cancellationToken)
    {
        using var handler = new SocketsHttpHandler
        {
            ConnectCallback = async (_, token) =>
            {
                var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
                try
                {
                    await socket.ConnectAsync(new UnixDomainSocketEndPoint(socketPath), token);
                    return new NetworkStream(socket, ownsSocket: true);
                }
                catch
                {
                    socket.Dispose();
                    throw;
                }
            },
        };
        using var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(10) };
        try
        {
            var health = await client.GetFromJsonAsync<HealthResponse>(
                new Uri("http://" + CoreLayout.HostNames[0] + HealthEndpoints.Path),
                CoreJson.Options,
                cancellationToken);
            return health is { Status: "ok", Layout: CoreLayoutName.Runova };
        }
        catch (Exception error) when (error is HttpRequestException or TaskCanceledException or System.Text.Json.JsonException)
        {
            return false;
        }
    }
}
