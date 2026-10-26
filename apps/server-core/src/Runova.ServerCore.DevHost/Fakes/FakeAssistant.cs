using System.Globalization;
using System.Runtime.CompilerServices;
using Runova.ServerCore.Assistant;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Docker;
using Runova.ServerCore.Execution;

namespace Runova.ServerCore.DevHost.Fakes;

/// <summary>
/// StreamExec on the pretend server: nothing runs. Each command is recorded and answered with
/// what the real one would print, a few lines a moment apart, so the Deploy AI's timeline and its
/// stop button have something to show. Unknown commands say they ran.
/// </summary>
internal sealed class FakeExecRunner(InMemoryDockerEngine engine, TimeProvider time) : IExecRunner
{
    private readonly List<ExecPlan> _ran = [];

    /// <summary>The pause between lines. The tests set it to zero.</summary>
    public TimeSpan LineDelay { get; init; } = TimeSpan.FromMilliseconds(80);

    /// <summary>Held by every run until a test completes it; completed, runs finish at once.</summary>
    public TaskCompletionSource Gate { get; set; } = Completed();

    /// <summary>Every plan the hub handed over, allowlisted or approved.</summary>
    public IReadOnlyList<ExecPlan> Ran
    {
        get
        {
            lock (_ran)
            {
                return [.. _ran];
            }
        }
    }

    public async Task<ProcessResult> RunAsync(ExecPlan plan, Action<OutputLine> onLine, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(onLine);
        lock (_ran)
        {
            _ran.Add(plan);
        }

        var (lines, code) = await AnswerAsync(plan, cancellationToken);
        foreach (var line in lines)
        {
            if (LineDelay > TimeSpan.Zero)
            {
                await Task.Delay(LineDelay, time, cancellationToken);
            }

            onLine(new OutputLine(code == 0 ? OutputStream.Out : OutputStream.Err, line));
        }

        await Gate.Task.WaitAsync(cancellationToken);
        return new ProcessResult(code, string.Empty, string.Empty, TimedOut: false, OutputTruncated: false);
    }

    private static TaskCompletionSource Completed()
    {
        var gate = new TaskCompletionSource();
        gate.SetResult();
        return gate;
    }

    private async Task<(string[] Lines, int Code)> AnswerAsync(ExecPlan plan, CancellationToken cancellationToken)
    {
        var words = plan.Program == ExecPlan.Shell ? ["sh", .. plan.Arguments] : (string[])[plan.Program, .. plan.Arguments];
        var head = string.Join(' ', words.Take(2));

        // A restart is the fix the Deploy AI reaches for: the pretend container comes back up, so
        // the problems feed clears the way it would on a real server. An approved command comes as
        // one line for the shell, so it is read from there too.
        var text = plan.Program == ExecPlan.Shell ? string.Join(' ', plan.Arguments.Skip(1)) : string.Join(' ', words);
        if (text.Split(' ', StringSplitOptions.RemoveEmptyEntries) is ["docker", "restart", var name])
        {
            try
            {
                await engine.RestartContainerAsync(name, timeoutSeconds: null, cancellationToken);
                return ([name], 0);
            }
            catch (Exception error) when (error is DockerRequestException or DockerNotFoundException)
            {
                return ([$"Error response from daemon: {error.Message}"], 1);
            }
        }

        switch (head)
        {
            case "docker ps":
            case "docker container":
                var list = await engine.ListContainersAsync(cancellationToken);
                return (
                    [
                        "CONTAINER ID   IMAGE                    STATUS",
                        .. list.Select(c => string.Create(CultureInfo.InvariantCulture, $"{c.Summary.Id[..12]}   {c.Summary.Image,-22} {c.Summary.Status}   {c.Summary.Name}")),
                    ],
                    0);
            case "docker logs":
                return (["mailer: connecting to smtp.internal:587", "Error: connect ECONNREFUSED 10.0.4.12:587", "mailer exited with code 1"], 0);
            case "docker inspect":
                return (["[", "  {", "    \"Name\": \"/" + (words.LastOrDefault() ?? string.Empty) + "\",", "    \"RestartCount\": 37,", "    \"State\": { \"Status\": \"restarting\", \"ExitCode\": 1 }", "  }", "]"], 0);
            case "df -h":
            case "df":
                return (["Filesystem      Size  Used Avail Use% Mounted on", "/dev/sda1        80G   41G   36G  54% /"], 0);
            case "free -h":
            case "free -m":
            case "free":
                return (["               total        used        free", "Mem:           7.8Gi       2.9Gi       3.1Gi"], 0);
            default:
                return ([$"(pretend server) ran: {string.Join(' ', plan.Program == ExecPlan.Shell ? plan.Arguments.Skip(1) : words)}"], 0);
        }
    }
}

/// <summary>A journal for any unit: the last lines at once, then a line every couple of seconds while followed.</summary>
internal sealed class FakeJournal(TimeProvider time) : IJournalSource
{
    public async IAsyncEnumerable<JournalLine> ReadAsync(JournalQuery query, [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        var now = time.GetUtcNow().ToUnixTimeMilliseconds();
        var count = Math.Min(query.Lines, 40);
        for (var i = count; i > 0; i--)
        {
            yield return Line(query.Unit, now - (i * 15_000), i);
        }

        if (!query.Follow)
        {
            yield break;
        }

        for (var n = 1; ; n++)
        {
            await Task.Delay(TimeSpan.FromSeconds(2), time, cancellationToken);
            yield return Line(query.Unit, time.GetUtcNow().ToUnixTimeMilliseconds(), n);
        }
    }

    private static JournalLine Line(string unit, long at, int n) => (n % 9) switch
    {
        0 => new JournalLine(at, 3, $"{unit}: failed to reach the registry (connection reset by peer)"),
        4 => new JournalLine(at, 4, $"{unit}: slow response from the health check ({200 + n} ms)"),
        _ => new JournalLine(at, 6, $"{unit}: handled request {n}"),
    };
}
