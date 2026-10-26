using Runova.ServerCore.Execution;

namespace Runova.ServerCore.Tests;

/// <summary>
/// Records every program the code under test would start and answers from rules, first match
/// wins. Anything no rule matches succeeds with no output.
/// </summary>
internal sealed class FakeProcessRunner : IProcessRunner
{
    private readonly List<(Func<ProcessSpec, bool> Matches, Func<ProcessCall, Task<ProcessResult>> Answer)> _rules = [];
    private readonly List<ProcessSpec> _calls = [];
    private readonly List<(Func<ProcessSpec, bool> Matches, TaskCompletionSource Seen)> _waiters = [];

    /// <summary>What was run, in order.</summary>
    public IReadOnlyList<ProcessSpec> Calls
    {
        get
        {
            lock (_calls)
            {
                return [.. _calls];
            }
        }
    }

    public static ProcessResult Ok(string output = "") => new(0, output, string.Empty, TimedOut: false, OutputTruncated: false);

    public static ProcessResult Exit(int code, string output = "", string error = "") =>
        new(code, output, error, TimedOut: false, OutputTruncated: false);

    /// <summary>A long-running command: it only ends when the caller cancels it.</summary>
    public static async Task<ProcessResult> UntilCancelled(ProcessCall call)
    {
        ArgumentNullException.ThrowIfNull(call);
        await Task.Delay(Timeout.Infinite, call.CancellationToken);
        return Ok();
    }

    public void Respond(Func<ProcessSpec, bool> matches, Func<ProcessCall, ProcessResult> answer) =>
        _rules.Add((matches, call => Task.FromResult(answer(call))));

    public void Respond(Func<ProcessSpec, bool> matches, Func<ProcessCall, Task<ProcessResult>> answer) =>
        _rules.Add((matches, answer));

    /// <summary>Answers a program by name (the file name of what would run) and its first arguments.</summary>
    public void Respond(string program, string[] leadingArguments, Func<ProcessCall, ProcessResult> answer) =>
        Respond(spec => Is(spec, program, leadingArguments), answer);

    public static bool Is(ProcessSpec spec, string program, params string[] leadingArguments)
    {
        ArgumentNullException.ThrowIfNull(spec);
        return Path.GetFileName(spec.Program) == program
            && spec.Arguments.Count >= leadingArguments.Length
            && spec.Arguments.Take(leadingArguments.Length).SequenceEqual(leadingArguments);
    }

    public async Task WaitForCallAsync(Func<ProcessSpec, bool> matches)
    {
        TaskCompletionSource seen;
        lock (_calls)
        {
            if (_calls.Any(matches))
            {
                return;
            }

            seen = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            _waiters.Add((matches, seen));
        }

        await seen.Task.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
    }

    public Task<ProcessResult> RunAsync(
        ProcessSpec spec,
        Action<OutputLine>? onLine = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(spec);
        lock (_calls)
        {
            _calls.Add(spec);
            foreach (var waiter in _waiters.Where(waiter => waiter.Matches(spec)).ToList())
            {
                waiter.Seen.TrySetResult();
                _waiters.Remove(waiter);
            }
        }

        cancellationToken.ThrowIfCancellationRequested();
        foreach (var (matches, answer) in _rules)
        {
            if (matches(spec))
            {
                return answer(new ProcessCall(spec, onLine, cancellationToken));
            }
        }

        return Task.FromResult(Ok());
    }
}

/// <summary>One call to the fake: what would run, where its lines go, and its cancellation.</summary>
internal sealed record ProcessCall(ProcessSpec Spec, Action<OutputLine>? OnLine, CancellationToken CancellationToken)
{
    /// <summary>Sends output lines the way a real process would, then answers.</summary>
    public ProcessResult Emit(params string[] lines)
    {
        foreach (var line in lines)
        {
            OnLine?.Invoke(new OutputLine(OutputStream.Out, line));
        }

        return FakeProcessRunner.Ok(string.Join('\n', lines) + (lines.Length > 0 ? "\n" : string.Empty));
    }
}
