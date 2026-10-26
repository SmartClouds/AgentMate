using Microsoft.Extensions.Logging.Abstractions;
using Runova.ServerCore.Assistant;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Execution;

namespace Runova.ServerCore.Tests.Assistant;

/// <summary>
/// How StreamExec commands and the journal reach the server (E09): an approved command goes to
/// /bin/sh in a collected transient unit (so a stop ends everything it started), an allowlisted one
/// runs from its own words, and journalctl is asked for JSON with nothing a caller can add to it.
/// A real systemd check runs on the test servers.
/// </summary>
public sealed class ExecRunnerTests
{
    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private static readonly Guid _id = Guid.Parse("0f8fad5b-d9cb-469f-a165-70867728950e");

    private static SystemdExecRunner Runner(FakeProcessRunner processes) =>
        new(new SystemdRunner(processes, TimeProvider.System, NullLogger<SystemdRunner>.Instance));

    [Fact]
    public async Task An_approved_command_runs_through_the_shell_in_its_own_unit_without_a_pager()
    {
        var processes = new FakeProcessRunner();
        processes.Respond(spec => spec.Program.EndsWith("systemd-run", StringComparison.Ordinal), call => call.Emit("ok"));
        var lines = new List<OutputLine>();

        var result = await Runner(processes).RunAsync(
            ExecPlan.Approved(_id, "systemctl restart nginx && echo done", "/srv", TimeSpan.FromSeconds(30)),
            lines.Add,
            Cancel);

        Assert.True(result.Succeeded);
        Assert.Equal("ok", Assert.Single(lines).Text);
        var run = Assert.Single(processes.Calls);
        var arguments = run.Arguments.ToList();
        Assert.Contains("--unit=runova-exec-0f8fad5bd9cb469fa16570867728950e", arguments);
        Assert.Contains("--collect", arguments);
        Assert.Contains("--wait", arguments);
        Assert.Contains("--pipe", arguments);
        Assert.Contains("--working-directory=/srv", arguments);
        Assert.Contains("--setenv=SYSTEMD_PAGER=cat", arguments);
        Assert.Contains("--setenv=TERM=dumb", arguments);
        Assert.Equal(["--", "/bin/sh", "-c", "systemctl restart nginx && echo done"], arguments[^4..]);
        Assert.Equal(0, run.MaxOutputBytes);
    }

    [Fact]
    public void An_allowlisted_command_keeps_its_words_apart()
    {
        var plan = ExecPlan.Allowlisted(_id, ["docker", "logs", "--tail", "50", "api"], null, TimeSpan.FromSeconds(5));
        Assert.Equal("docker", plan.Program);
        Assert.Equal(["logs", "--tail", "50", "api"], plan.Arguments);
        Assert.Null(plan.WorkingDirectory);
    }

    [Fact]
    public async Task A_program_that_is_not_installed_fails_before_anything_starts()
    {
        var processes = new FakeProcessRunner();
        await Assert.ThrowsAsync<ProcessStartException>(() => Runner(processes).RunAsync(
            ExecPlan.Allowlisted(_id, ["no-such-program-runova"], null, TimeSpan.FromSeconds(5)),
            _ => { },
            Cancel));
        Assert.Empty(processes.Calls);
    }

    [Fact]
    public async Task The_journal_asks_journalctl_for_json_and_parses_each_entry()
    {
        var processes = new FakeProcessRunner();
        processes.Respond("journalctl", [], call => call.Emit(
            """{"__REALTIME_TIMESTAMP":"1700000000000000","PRIORITY":"6","MESSAGE":"started"}""",
            "not json",
            """{"__REALTIME_TIMESTAMP":"1700000001000000","PRIORITY":"3","MESSAGE":"failed"}"""));

        var lines = new List<JournalLine>();
        await foreach (var line in new JournalctlSource(processes).ReadAsync(new JournalQuery("nginx.service", 50, 1_700_000_000_000, Follow: false), Cancel))
        {
            lines.Add(line);
        }

        Assert.Equal(["started", "failed"], lines.Select(l => l.Text));
        var call = Assert.Single(processes.Calls);
        Assert.Equal(["--no-pager", "--output=json", "--unit=nginx.service", "--lines=50", "--since=@1700000000"], call.Arguments);
        Assert.Equal(TimeSpan.FromSeconds(30), call.Timeout);
    }

    [Fact]
    public async Task A_followed_journal_runs_until_the_stream_ends_and_a_failure_reaches_the_reader()
    {
        var processes = new FakeProcessRunner();
        processes.Respond(
            spec => FakeProcessRunner.Is(spec, "journalctl"),
            async call =>
            {
                call.Emit("""{"MESSAGE":"one"}""");
                return await FakeProcessRunner.UntilCancelled(call);
            });
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(Cancel);
        await using (var reader = new JournalctlSource(processes).ReadAsync(new JournalQuery("docker", 10, null, Follow: true), stop.Token).GetAsyncEnumerator(stop.Token))
        {
            Assert.True(await reader.MoveNextAsync());
            Assert.Equal("one", reader.Current.Text);
            await stop.CancelAsync();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(async () => await reader.MoveNextAsync());
        }

        var call = Assert.Single(processes.Calls);
        Assert.Contains("--follow", call.Arguments);
        Assert.Equal(ProcessRunner.MaxTimeout, call.Timeout);

        var failing = new FakeProcessRunner();
        failing.Respond(spec => FakeProcessRunner.Is(spec, "journalctl"), Fail);
        await Assert.ThrowsAsync<ProcessStartException>(async () =>
        {
            await foreach (var _ in new JournalctlSource(failing).ReadAsync(new JournalQuery("docker", 10, null, Follow: false), Cancel))
            {
            }
        });
    }

    private static ProcessResult Fail(ProcessCall call) => throw new ProcessStartException("journalctl is not installed");

    [Theory]
    [InlineData("docker.service", true)]
    [InlineData("nginx", true)]
    [InlineData("systemd-fsck@dev-disk.service", true)]
    [InlineData("-f", false)]
    [InlineData("../etc", false)]
    [InlineData("a b", false)]
    [InlineData("nginx*", false)]
    [InlineData(null, false)]
    public void Unit_names_are_checked(string? unit, bool valid)
    {
        Assert.Equal(valid, JournalUnits.IsUnit(unit));
    }

    [Fact]
    public void Container_secrets_count_under_a_secret_name_when_long_or_inside_a_url()
    {
        Assert.Equal(["s3cr3t"], ExecSecrets.Secrets("DB_PASSWORD", "s3cr3t"));
        Assert.Empty(ExecSecrets.Secrets("POSTGRES_USER", "shop"));
        Assert.Equal(["a-very-long-plain-value-1234"], ExecSecrets.Secrets("SOMETHING", "a-very-long-plain-value-1234"));
        Assert.Equal(["smtp://u:pw12@host:25", "pw12"], ExecSecrets.Secrets("SMTP_URL", "smtp://u:pw12@host:25"));
    }
}
