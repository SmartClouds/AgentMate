using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.Extensions.Time.Testing;
using Runova.ServerCore.Audit;
using Runova.ServerCore.Data;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Tests;

/// <summary>
/// The audit trail is append-only and hash-chained: each event's hash covers the one before it,
/// so editing, deleting or reordering any stored event shows up when the chain is verified. The
/// service and the admin command both append, so appends must never fork the chain.
/// </summary>
public sealed class AuditLogTests
{
    private static readonly FakeTimeProvider _clock = new(DateTimeOffset.FromUnixTimeMilliseconds(1_700_000_000_000));

    private static AuditLog Log(TestDatabase database) => new(database.Contexts, _clock, new Redactor());

    private static AuditEntry Entry(string action, IReadOnlyDictionary<string, string?>? parameters = null) =>
        new(action, AuditResult.Success, Parameters: parameters);

    [Fact]
    public async Task An_untouched_chain_verifies()
    {
        await using var database = await TestDatabase.CreateAsync();
        var log = Log(database);

        for (var i = 0; i < 5; i++)
        {
            await log.AppendAsync(Entry($"test.{i}"), TestContext.Current.CancellationToken);
        }

        var verification = await log.VerifyAsync(TestContext.Current.CancellationToken);
        Assert.True(verification.Intact);
        Assert.Equal(5, verification.Checked);
        Assert.Null(verification.BrokenAt);
    }

    [Fact]
    public async Task Editing_any_event_breaks_the_chain_at_that_event()
    {
        await using var database = await TestDatabase.CreateAsync();
        var log = Log(database);
        for (var i = 0; i < 4; i++)
        {
            await log.AppendAsync(Entry($"test.{i}"), TestContext.Current.CancellationToken);
        }

        await using (var db = await database.Contexts.CreateDbContextAsync(TestContext.Current.CancellationToken))
        {
            await db.Database.ExecuteSqlRawAsync(
                "UPDATE AuditEvents SET Result = 'failed' WHERE Id = 3",
                TestContext.Current.CancellationToken);
        }

        var verification = await log.VerifyAsync(TestContext.Current.CancellationToken);
        Assert.False(verification.Intact);
        Assert.Equal(3, verification.BrokenAt);
    }

    [Fact]
    public async Task Deleting_an_event_breaks_the_chain()
    {
        await using var database = await TestDatabase.CreateAsync();
        var log = Log(database);
        for (var i = 0; i < 4; i++)
        {
            await log.AppendAsync(Entry($"test.{i}"), TestContext.Current.CancellationToken);
        }

        await using (var db = await database.Contexts.CreateDbContextAsync(TestContext.Current.CancellationToken))
        {
            await db.Database.ExecuteSqlRawAsync("DELETE FROM AuditEvents WHERE Id = 2", TestContext.Current.CancellationToken);
        }

        var verification = await log.VerifyAsync(TestContext.Current.CancellationToken);
        Assert.False(verification.Intact);
        Assert.Equal(3, verification.BrokenAt);
    }

    [Fact]
    public async Task Writers_in_separate_processes_never_fork_the_chain()
    {
        await using var database = await TestDatabase.CreateAsync();
        // Two logs over their own connections stand in for the service and the admin command.
        var service = Log(database);
        var admin = new AuditLog(new PooledDbContextFactory<CoreDbContext>(CoreDatabase.Options(database.Path)), _clock, new Redactor());

        await Task.WhenAll(Enumerable.Range(0, 40).Select(i =>
            (i % 2 == 0 ? service : admin).AppendAsync(Entry($"race.{i}"), TestContext.Current.CancellationToken)));

        var verification = await service.VerifyAsync(TestContext.Current.CancellationToken);
        Assert.True(verification.Intact);
        Assert.Equal(40, verification.Checked);
    }

    [Fact]
    public async Task Secrets_never_reach_the_stored_parameters()
    {
        await using var database = await TestDatabase.CreateAsync();
        var log = Log(database);

        var stored = await log.AppendAsync(
            Entry("auth.login", new Dictionary<string, string?>
            {
                ["username"] = "owner",
                ["password"] = "correct horse",
                ["totpCode"] = "123456",
                ["accessToken"] = "abc",
                ["enrollmentCode"] = "XYZ",
            }),
            TestContext.Current.CancellationToken);

        Assert.NotNull(stored.Parameters);
        Assert.Contains("owner", stored.Parameters, StringComparison.Ordinal);
        foreach (var secret in new[] { "correct horse", "123456", "abc", "XYZ" })
        {
            Assert.DoesNotContain(secret, stored.Parameters, StringComparison.Ordinal);
        }
    }

    [Fact]
    public async Task Pruning_old_events_keeps_the_rest_verifiable()
    {
        await using var database = await TestDatabase.CreateAsync();
        var clock = new FakeTimeProvider(DateTimeOffset.FromUnixTimeMilliseconds(1_700_000_000_000));
        var log = new AuditLog(database.Contexts, clock, new Redactor());
        for (var i = 0; i < 3; i++)
        {
            await log.AppendAsync(Entry($"old.{i}"), TestContext.Current.CancellationToken);
        }

        clock.Advance(TimeSpan.FromDays(400));
        for (var i = 0; i < 2; i++)
        {
            await log.AppendAsync(Entry($"new.{i}"), TestContext.Current.CancellationToken);
        }

        var pruned = await log.PruneAsync(clock.GetUtcNow().AddDays(-365), TestContext.Current.CancellationToken);
        var verification = await log.VerifyAsync(TestContext.Current.CancellationToken);

        Assert.Equal(3, pruned);
        Assert.True(verification.Intact);
        Assert.Equal(2, verification.Checked);
    }

    [Fact]
    public async Task Pruning_cannot_hide_an_edit_to_what_is_left()
    {
        await using var database = await TestDatabase.CreateAsync();
        var clock = new FakeTimeProvider(DateTimeOffset.FromUnixTimeMilliseconds(1_700_000_000_000));
        var log = new AuditLog(database.Contexts, clock, new Redactor());
        await log.AppendAsync(Entry("old"), TestContext.Current.CancellationToken);
        clock.Advance(TimeSpan.FromDays(400));
        await log.AppendAsync(Entry("new.0"), TestContext.Current.CancellationToken);
        await log.AppendAsync(Entry("new.1"), TestContext.Current.CancellationToken);
        await log.PruneAsync(clock.GetUtcNow().AddDays(-365), TestContext.Current.CancellationToken);

        await using (var db = await database.Contexts.CreateDbContextAsync(TestContext.Current.CancellationToken))
        {
            await db.Database.ExecuteSqlRawAsync(
                "UPDATE AuditEvents SET Action = 'hidden' WHERE Id = 2",
                TestContext.Current.CancellationToken);
        }

        Assert.False((await log.VerifyAsync(TestContext.Current.CancellationToken)).Intact);
    }
}
