using Microsoft.Extensions.Time.Testing;
using Runova.ServerCore.Audit;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Tests;

/// <summary>The audit trail keeps a year of events; older ones are pruned and the rest still verifies.</summary>
public sealed class AuditRetentionTests
{
    [Fact]
    public async Task A_run_prunes_what_is_older_than_the_retention()
    {
        await using var database = await TestDatabase.CreateAsync();
        var clock = new FakeTimeProvider(DateTimeOffset.FromUnixTimeMilliseconds(1_700_000_000_000));
        using var log = new AuditLog(database.Contexts, clock, new Redactor());
        await log.AppendAsync(new AuditEntry("old", AuditResult.Success), TestContext.Current.CancellationToken);
        clock.Advance(AuditRetention.Keep + TimeSpan.FromDays(1));
        await log.AppendAsync(new AuditEntry("new", AuditResult.Success), TestContext.Current.CancellationToken);
        var retention = new AuditRetention(log, clock, Microsoft.Extensions.Logging.Abstractions.NullLogger<AuditRetention>.Instance);

        var pruned = await retention.RunOnceAsync(TestContext.Current.CancellationToken);

        Assert.Equal(1, pruned);
        var verification = await log.VerifyAsync(TestContext.Current.CancellationToken);
        Assert.True(verification.Intact);
        Assert.Equal(1, verification.Checked);
    }
}
