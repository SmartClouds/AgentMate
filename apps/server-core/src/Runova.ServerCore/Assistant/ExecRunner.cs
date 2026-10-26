using System.Text.RegularExpressions;
using Runova.ServerCore.Docker;
using Runova.ServerCore.Execution;
using Runova.ServerCore.Hosting;
using Runova.ServerCore.Security;
using Runova.ServerCore.Stacks;

namespace Runova.ServerCore.Assistant;

/// <summary>
/// One StreamExec command, ready to run. An allowlisted command is its own argument list (the
/// runner resolves its program to an absolute path); an approved one goes to <c>/bin/sh -c</c> as
/// typed.
/// </summary>
internal sealed record ExecPlan(Guid Id, string Program, IReadOnlyList<string> Arguments, string? WorkingDirectory, TimeSpan Timeout)
{
    public const string Shell = "/bin/sh";

    public static ExecPlan Allowlisted(Guid id, string[] words, string? workingDirectory, TimeSpan timeout) =>
        new(id, words[0], words[1..], workingDirectory, timeout);

    public static ExecPlan Approved(Guid id, string command, string? workingDirectory, TimeSpan timeout) =>
        new(id, Shell, ["-c", command], workingDirectory, timeout);
}

/// <summary>Runs StreamExec commands. Cancelling or running out of time ends every process the command started.</summary>
internal interface IExecRunner
{
    Task<ProcessResult> RunAsync(ExecPlan plan, Action<OutputLine> onLine, CancellationToken cancellationToken);
}

/// <summary>
/// Each command in a transient unit of its own (<c>systemd-run --collect --wait --pipe</c>), as
/// package jobs run: a normal environment for a service, its own cgroup, and stopping the unit on
/// cancel or timeout kills everything in it, whatever the command forked.
/// </summary>
internal sealed class SystemdExecRunner(SystemdRunner systemd) : IExecRunner
{
    /// <summary>No pager, no colours and no prompts: the output goes to a person reading text.</summary>
    private static readonly Dictionary<string, string> _environment = new(StringComparer.Ordinal)
    {
        ["TERM"] = "dumb",
        ["PAGER"] = "cat",
        ["SYSTEMD_PAGER"] = "cat",
        ["SYSTEMD_COLORS"] = "0",
        ["NO_COLOR"] = "1",
        ["DEBIAN_FRONTEND"] = "noninteractive",
    };

    public Task<ProcessResult> RunAsync(ExecPlan plan, Action<OutputLine> onLine, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(plan);
        return systemd.RunAsync(
            SystemdRunner.UnitName("exec", plan.Id),
            "a command from the app",
            new ProcessSpec
            {
                Program = ProcessRunner.Resolve(plan.Program),
                Arguments = plan.Arguments,
                WorkingDirectory = plan.WorkingDirectory,
                Environment = _environment,
                Timeout = plan.Timeout,
                // Lines reach the stream through the callback; the result keeps none of them.
                MaxOutputBytes = 0,
            },
            onLine,
            cancellationToken);
    }
}

/// <summary>
/// The redactor for command output and the journal: seeded with every stack's env values (every
/// revision on disk) and every container's environment, because `docker inspect` and a careless
/// log line can print any of them, not only those of the app being looked at.
/// </summary>
internal sealed partial class ExecSecrets(IDockerEngine engine, CoreDirectories directories, Redactor redactor, ILogger<ExecSecrets> logger)
{
    public async Task<Redactor> RedactorAsync(CancellationToken cancellationToken)
    {
        var values = new List<string>();
        if (Directory.Exists(directories.Stacks))
        {
            foreach (var revisions in Directory.EnumerateDirectories(directories.Stacks).Select(stack => Path.Combine(stack, "revisions")).Where(Directory.Exists))
            {
                foreach (var revision in Directory.EnumerateDirectories(revisions))
                {
                    values.AddRange(await StackOperations.EnvValuesAsync(revision, cancellationToken));
                }
            }
        }

        try
        {
            foreach (var container in await engine.ListContainersAsync(cancellationToken))
            {
                try
                {
                    var inspection = await engine.InspectContainerAsync(container.Summary.Id, cancellationToken);
                    values.AddRange(inspection.Environment.SelectMany(entry => Secrets(entry.Key, entry.Value)));
                }
                catch (DockerNotFoundException)
                {
                    // Removed since the list was read.
                }
            }
        }
        catch (Exception error) when (error is DockerUnavailableException or DockerRequestException or HttpRequestException or IOException)
        {
            // No engine, no container secrets to hide; the stacks' values are still seeded.
            ExecSecretsLog.EngineUnavailable(logger, error);
        }

        return redactor.With(values);
    }

    /// <summary>
    /// What to hide of a container's variable. A stack's own values are all seeded (its .env is
    /// the user's), but a container also carries plain settings (POSTGRES_USER=shop, PORT=3000)
    /// that would blank out every mention of them across the whole server: those count only
    /// under a secret-like name, when they are long enough to be a key, or as a URL's password.
    /// </summary>
    internal static IEnumerable<string> Secrets(string name, string value)
    {
        if (Redactor.IsSecretName(name) || value.Length >= MinPlainLength)
        {
            yield return value;
        }

        foreach (var match in UrlPassword().Matches(value).Cast<Match>())
        {
            yield return match.Groups[1].Value;
        }
    }

    private const int MinPlainLength = 16;

    [GeneratedRegex(@"://[^\s:/@]+:([^\s@/]+)@", RegexOptions.CultureInvariant, 200)]
    private static partial Regex UrlPassword();
}

internal static partial class ExecSecretsLog
{
    [LoggerMessage(Level = LogLevel.Debug, Message = "Docker did not answer while seeding the exec redactor.")]
    public static partial void EngineUnavailable(ILogger logger, Exception error);
}
