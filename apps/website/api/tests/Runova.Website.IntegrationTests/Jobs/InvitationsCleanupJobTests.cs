using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;
using Runova.Website.Api.Users;
using Runova.Website.Data;
using Runova.Website.Data.Identity;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Jobs;

public sealed class InvitationsCleanupJobTests(PostgresFixture postgres) : IAsyncLifetime
{
    private readonly FakeTimeProvider _time = new(new DateTimeOffset(2026, 10, 30, 12, 0, 0, TimeSpan.Zero));
    private WebsiteApiFactory _factory = null!;

    // A database of its own: the job deletes by the fake clock, which other tests' links do not follow.
    public async ValueTask InitializeAsync() => _factory = new(await postgres.CreateDatabaseAsync(), time: _time);

    public ValueTask DisposeAsync()
    {
        _factory.Dispose();
        return ValueTask.CompletedTask;
    }

    [Fact]
    public async Task The_job_deletes_only_expired_invitations()
    {
        var now = _time.GetUtcNow();
        var expired = await AddLinkAsync(SetupLinkPurposes.Invitation, now.AddHours(-1));
        var expiringNow = await AddLinkAsync(SetupLinkPurposes.Invitation, now);
        var live = await AddLinkAsync(SetupLinkPurposes.Invitation, now.AddMinutes(1));
        var expiredReset = await AddLinkAsync(SetupLinkPurposes.PasswordReset, now.AddHours(-1));
        var liveReset = await AddLinkAsync(SetupLinkPurposes.PasswordReset, now.AddHours(1));

        using (var scope = _factory.Services.CreateScope())
        {
            await scope.ServiceProvider.GetRequiredService<InvitationsCleanupJob>().RunAsync(TestContext.Current.CancellationToken);
        }

        using var check = _factory.Services.CreateScope();
        var left = await check.ServiceProvider.GetRequiredService<AppDbContext>().SetupLinks
            .Select(l => l.Id)
            .ToListAsync(TestContext.Current.CancellationToken);
        Assert.Equal([live, expiredReset, liveReset], left.Order());
        Assert.DoesNotContain(expired, left);
        Assert.DoesNotContain(expiringNow, left);
    }

    [Fact]
    public async Task The_job_leaves_the_invited_user_in_place()
    {
        var link = await AddLinkAsync(SetupLinkPurposes.Invitation, _time.GetUtcNow().AddHours(-1));

        using (var scope = _factory.Services.CreateScope())
        {
            await scope.ServiceProvider.GetRequiredService<InvitationsCleanupJob>().RunAsync(TestContext.Current.CancellationToken);
        }

        using var check = _factory.Services.CreateScope();
        var db = check.ServiceProvider.GetRequiredService<AppDbContext>();
        Assert.False(await db.SetupLinks.AnyAsync(l => l.Id == link, TestContext.Current.CancellationToken));
        Assert.Equal(1, await db.Users.CountAsync(TestContext.Current.CancellationToken));
    }

    private async Task<long> AddLinkAsync(string purpose, DateTimeOffset expiresAt)
    {
        var user = await TestUsers.CreateAsync(_factory.Services);
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var link = new SetupLink
        {
            UserId = user.Id,
            Purpose = purpose,
            TokenHash = Guid.NewGuid().ToByteArray(),
            CreatedAt = expiresAt.AddHours(-24),
            ExpiresAt = expiresAt,
        };
        db.SetupLinks.Add(link);
        await db.SaveChangesAsync(TestContext.Current.CancellationToken);
        return link.Id;
    }
}
