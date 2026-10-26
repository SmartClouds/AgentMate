using Runova.ServerCore.Execution;

namespace Runova.ServerCore.Stacks;

/// <summary>A stack's compose project on disk, as every docker compose call names it.</summary>
/// <param name="Name">The compose project name (the stack's name).</param>
/// <param name="ProjectDirectory">Where relative paths in the files resolve: the revision's files/ folder.</param>
/// <param name="Files">The user's compose file, then the loopback override when there is one.</param>
/// <param name="EnvFile">The rendered .env.</param>
internal sealed record ComposeProject(string Name, string ProjectDirectory, IReadOnlyList<string> Files, string EnvFile);

/// <summary>How one docker compose call runs.</summary>
/// <param name="UnitName">A transient unit to run it in (a job's step), or null for a quick call run directly.</param>
/// <param name="Environment">
/// Extra variables for the call. Only DOCKER_CONFIG goes here (the path of a job's registry
/// sign-ins, E08); a value in it is never a secret, since it reaches systemd-run's argv.
/// </param>
internal sealed record ComposeRunOptions(
    TimeSpan Timeout,
    string? UnitName = null,
    int MaxOutputBytes = 1024 * 1024,
    IReadOnlyDictionary<string, string>? Environment = null);

/// <summary>
/// Runs `docker compose` for a stack. The real one goes through <see cref="IProcessRunner"/> and,
/// for a job's steps, a transient unit; the DevHost and the tests put a simulation in its place.
/// </summary>
internal interface IComposeRunner
{
    /// <summary>`docker compose version --short`, or null when Compose is not there.</summary>
    Task<string?> VersionAsync(CancellationToken cancellationToken);

    Task<ProcessResult> RunAsync(
        ComposeProject project,
        IReadOnlyList<string> arguments,
        ComposeRunOptions options,
        Action<OutputLine>? onLine,
        CancellationToken cancellationToken);
}

/// <summary>
/// docker compose on the server. Arguments are a list (never a shell string); the environment is
/// the runner's fixed one, so nothing of the core's own environment reaches Compose's
/// interpolation, and env values only ever travel in the .env file.
/// </summary>
internal sealed class DockerComposeRunner(IProcessRunner runner, SystemdRunner units) : IComposeRunner
{
    public async Task<string?> VersionAsync(CancellationToken cancellationToken)
    {
        try
        {
            var result = await runner.RunAsync(
                new ProcessSpec { Program = "docker", Arguments = ["compose", "version", "--short"], Timeout = TimeSpan.FromSeconds(30) },
                onLine: null,
                cancellationToken);
            return result.Succeeded && result.StandardOutput.Trim() is { Length: > 0 } text ? text : null;
        }
        catch (ProcessStartException)
        {
            return null;
        }
    }

    public Task<ProcessResult> RunAsync(
        ComposeProject project,
        IReadOnlyList<string> arguments,
        ComposeRunOptions options,
        Action<OutputLine>? onLine,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(project);
        ArgumentNullException.ThrowIfNull(arguments);
        ArgumentNullException.ThrowIfNull(options);
        var spec = new ProcessSpec
        {
            // A transient unit runs its program by absolute path (/usr/bin/docker).
            Program = options.UnitName is null ? "docker" : ProcessRunner.Resolve("docker"),
            Arguments = CommandLine(project, arguments),
            WorkingDirectory = project.ProjectDirectory,
            Timeout = options.Timeout,
            MaxOutputBytes = options.MaxOutputBytes,
            Environment = options.Environment ?? new Dictionary<string, string>(),
        };
        return options.UnitName is { } unit
            ? units.RunAsync(unit, $"Runova: docker compose {(arguments.Count > 0 ? arguments[0] : "run")} for {project.Name}", spec, onLine, cancellationToken)
            : runner.RunAsync(spec, onLine, cancellationToken);
    }

    /// <summary>`compose --project-name ... -f ... --env-file ...` followed by the command.</summary>
    public static List<string> CommandLine(ComposeProject project, IReadOnlyList<string> arguments)
    {
        ArgumentNullException.ThrowIfNull(project);
        ArgumentNullException.ThrowIfNull(arguments);
        List<string> line = ["compose", "--ansi", "never", "--progress", "plain", "--project-name", project.Name, "--project-directory", project.ProjectDirectory];
        foreach (var file in project.Files)
        {
            line.Add("--file");
            line.Add(file);
        }

        line.Add("--env-file");
        line.Add(project.EnvFile);
        line.AddRange(arguments);
        return line;
    }
}
