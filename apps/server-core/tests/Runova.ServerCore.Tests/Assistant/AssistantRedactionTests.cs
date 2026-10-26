using System.Runtime.CompilerServices;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Runova.ServerCore.Assistant;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Docker;
using Runova.ServerCore.Security;
using Runova.ServerCore.Tests.Stacks;

namespace Runova.ServerCore.Tests.Assistant;

/// <summary>
/// No env value reaches the app through the exec stream or the journal (E09 AC4): output is
/// redacted with every stack's env values and every container's environment, including those of
/// containers that belong to no stack, and the audit trail never keeps one either.
/// </summary>
public sealed class AssistantRedactionTests
{
    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Command_output_and_its_audit_entry_never_carry_a_stack_or_container_secret()
    {
        await using var kit = await StackKit.CreateAsync(CoreRoles.Admin);
        var stack = await kit.CreateStackAsync();
        await kit.UploadAsync(stack.Id, StackKit.Upload());
        var signedIn = await kit.Harness.SignInAsync();
        await using var hub = kit.Harness.Hub(signedIn.AccessToken);
        await hub.StartAsync(Cancel);
        var connected = new AssistantHubTests.Connected(kit.Harness, hub, signedIn.SessionId);

        // The fake runner prints the command it ran; each of these is a secret somewhere on the server.
        var command = $"echo {StackKit.Secret} {InMemoryDockerEngine.ApiToken} {InMemoryDockerEngine.DatabasePassword}";
        var output = await AssistantHubTests.ExecAsync(hub, new ExecRequest(command, FromAssistant: true, Approval: await AssistantHubTests.ApproveAsync(connected, command)));

        var text = string.Join('\n', output.SelectMany(o => o.Lines).Select(l => l.Text));
        Assert.Contains(Redactor.Mask, text, StringComparison.Ordinal);
        Assert.DoesNotContain(StackKit.Secret, text, StringComparison.Ordinal);
        Assert.DoesNotContain(InMemoryDockerEngine.ApiToken, text, StringComparison.Ordinal);
        Assert.DoesNotContain(InMemoryDockerEngine.DatabasePassword, text, StringComparison.Ordinal);

        await using var scope = kit.Harness.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<CoreDbContext>();
        var audit = await db.AuditEvents.Where(e => e.Action.StartsWith("exec.")).Select(e => e.Parameters).ToListAsync(Cancel);
        Assert.NotEmpty(audit);
        Assert.All(audit, parameters =>
        {
            Assert.DoesNotContain(StackKit.Secret, parameters ?? string.Empty, StringComparison.Ordinal);
            Assert.DoesNotContain(InMemoryDockerEngine.ApiToken, parameters ?? string.Empty, StringComparison.Ordinal);
        });
    }

    [Fact]
    public async Task The_journal_is_redacted_and_only_takes_a_unit_name()
    {
        await using var harness = await AuthHarness.CreateAsync(
            CoreRoles.Admin,
            services: (services, _) => services.AddSingleton<IJournalSource, LeakyJournal>());
        var signedIn = await harness.SignInAsync();
        await using var hub = harness.Hub(signedIn.AccessToken);
        await hub.StartAsync(Cancel);

        var lines = new List<JournalLine>();
        await foreach (var batch in hub.StreamAsync<JournalBatch>(nameof(ICoreHub.StreamJournal), new JournalRequest("docker.service", 10, Follow: false), Cancel))
        {
            lines.AddRange(batch.Lines);
        }

        Assert.Equal(2, lines.Count);
        Assert.Equal(3, lines[1].Priority);
        Assert.DoesNotContain(InMemoryDockerEngine.ApiToken, lines[1].Text, StringComparison.Ordinal);
        Assert.Contains(Redactor.Mask, lines[1].Text, StringComparison.Ordinal);

        foreach (var unit in new[] { "-f", "../etc", "docker service", "nginx;id", string.Empty, new string('a', 200) })
        {
            await Assert.ThrowsAsync<HubException>(async () =>
            {
                await foreach (var _ in hub.StreamAsync<JournalBatch>(nameof(ICoreHub.StreamJournal), new JournalRequest(unit), Cancel))
                {
                }
            });
        }

        await Assert.ThrowsAsync<HubException>(async () =>
        {
            await foreach (var _ in hub.StreamAsync<JournalBatch>(nameof(ICoreHub.StreamJournal), new JournalRequest("nginx", 5_000), Cancel))
            {
            }
        });
    }

    [Fact]
    public async Task Viewers_cannot_read_the_journal()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Operator);
        var signedIn = await harness.SignInAsync();
        await using var hub = harness.Hub(signedIn.AccessToken);
        await hub.StartAsync(Cancel);
        await Assert.ThrowsAsync<HubException>(async () =>
        {
            await foreach (var _ in hub.StreamAsync<JournalBatch>(nameof(ICoreHub.StreamJournal), new JournalRequest("nginx"), Cancel))
            {
            }
        });
    }

    [Fact]
    public void Journalctl_json_lines_parse_with_their_time_priority_and_message()
    {
        var line = JournalctlSource.Parse("""{"__REALTIME_TIMESTAMP":"1700000000123456","PRIORITY":"3","MESSAGE":"failed"}""");
        Assert.Equal(new JournalLine(1_700_000_000_123, 3, "failed"), line);
        Assert.Equal("hé", JournalctlSource.Parse("""{"MESSAGE":[104,195,169]}""")!.Text);
        Assert.Equal(6, JournalctlSource.Parse("""{"MESSAGE":"x"}""")!.Priority);
        Assert.Null(JournalctlSource.Parse("not json"));
        Assert.Null(JournalctlSource.Parse("[1,2]"));
        Assert.Equal(8 * 1024, JournalctlSource.Parse($$"""{"MESSAGE":"{{new string('a', 9_000)}}"}""")!.Text.Length);
    }

    private sealed class LeakyJournal : IJournalSource
    {
        public async IAsyncEnumerable<JournalLine> ReadAsync(JournalQuery query, [EnumeratorCancellation] CancellationToken cancellationToken)
        {
            await Task.Yield();
            yield return new JournalLine(1, 6, "starting");
            yield return new JournalLine(2, 3, $"auth failed for token {InMemoryDockerEngine.ApiToken}");
        }
    }
}
