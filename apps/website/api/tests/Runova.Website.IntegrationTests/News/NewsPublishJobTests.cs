using System.Net;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;
using Runova.Website.Api.Jobs;
using Runova.Website.Api.News;
using Runova.Website.Core.Identity;
using Runova.Website.Core.News;
using Runova.Website.Data;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.News;

public sealed class NewsPublishJobTests(PostgresFixture postgres) : IAsyncLifetime
{
    private const string News = "/api/v1/news";

    private static readonly DateTimeOffset _now = new(2026, 10, 30, 12, 0, 0, TimeSpan.Zero);

    private readonly FakeTimeProvider _time = new(_now);
    private WebsiteApiFactory _factory = null!;

    // A database of its own: the job publishes by the fake clock, which other tests' items do not follow.
    public async ValueTask InitializeAsync() => _factory = new(await postgres.CreateDatabaseAsync(), time: _time);

    public ValueTask DisposeAsync()
    {
        _factory.Dispose();
        return ValueTask.CompletedTask;
    }

    [Fact]
    public async Task A_scheduled_item_stays_out_of_the_list_until_the_job_runs_at_its_time()
    {
        var editor = await TestUsers.SignedInClientAsync(_factory, await TestUsers.CreateAsync(_factory.Services, Roles.Editor));
        var (id, _) = await NewsWriteTests.CreateAsync(
            editor, NewsWriteTests.Body("scheduled-for-later", status: "scheduled", publishedAt: _now.AddMinutes(30)));
        Assert.Empty(await PublicSlugsAsync(editor));

        await RunJobAsync();
        Assert.Empty(await PublicSlugsAsync(editor));

        _time.Advance(TimeSpan.FromMinutes(30));
        Assert.Empty(await PublicSlugsAsync(editor));

        await RunJobAsync();
        Assert.Equal(["scheduled-for-later"], await PublicSlugsAsync(editor));

        var item = await ApiClient.ReadJsonAsync(await editor.GetAsync($"{News}/{id}"), HttpStatusCode.OK);
        Assert.Equal("published", item.GetProperty("status").GetString());
        Assert.Equal("2026-10-30T12:30:00.000Z", item.GetProperty("publishedAt").GetString());
        Assert.Equal("2026-10-30T12:30:00.000Z", item.GetProperty("updatedAt").GetString());
    }

    [Fact]
    public async Task The_job_publishes_only_scheduled_items_whose_time_has_come_and_audits_each()
    {
        await TestNews.AddAsync(
            _factory.Services,
            TestNews.Item("due-a-while-ago", _now.AddHours(-1), NewsStatus.Scheduled),
            TestNews.Item("due-this-instant", _now, NewsStatus.Scheduled),
            TestNews.Item("due-later", _now.AddSeconds(1), NewsStatus.Scheduled),
            TestNews.Item("a-dated-draft", _now.AddHours(-1), NewsStatus.Draft),
            TestNews.Item("an-archived-one", _now.AddHours(-1), NewsStatus.Archived));

        await RunJobAsync();

        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var statuses = await db.NewsItems.AsNoTracking().OrderBy(i => i.Slug)
            .Select(i => new { i.Slug, i.Status })
            .ToListAsync(TestContext.Current.CancellationToken);
        Assert.Equal(
            [
                ("a-dated-draft", NewsStatus.Draft), ("an-archived-one", NewsStatus.Archived), ("due-a-while-ago", NewsStatus.Published),
                ("due-later", NewsStatus.Scheduled), ("due-this-instant", NewsStatus.Published),
            ],
            statuses.Select(s => (s.Slug, s.Status)));

        var published = await db.NewsItems.AsNoTracking().Where(i => i.Status == NewsStatus.Published)
            .Select(i => i.Id.ToString())
            .ToListAsync(TestContext.Current.CancellationToken);
        var entries = await db.AuditEntries.AsNoTracking().OrderBy(e => e.TargetId).ToListAsync(TestContext.Current.CancellationToken);
        Assert.Equal(published.Order(), entries.Select(e => e.TargetId));
        Assert.All(entries, entry =>
        {
            Assert.Equal("news.publish", entry.Action);
            Assert.Equal("news", entry.TargetType);
            Assert.Equal("system", entry.ActorKind);
            Assert.Null(entry.ActorId);
            Assert.Equal(_now, entry.At);
        });
    }

    [Fact]
    public void The_job_runs_every_minute()
    {
        Assert.Equal("* * * * *", RecurringJobRegistry.Schedules[RecurringJobRegistry.NewsPublish]);
    }

    private async Task RunJobAsync()
    {
        using var scope = _factory.Services.CreateScope();
        await scope.ServiceProvider.GetRequiredService<NewsPublishJob>().RunAsync(TestContext.Current.CancellationToken);
    }

    private static async Task<List<string>> PublicSlugsAsync(ApiClient client)
    {
        var page = await ApiClient.ReadJsonAsync(await client.GetAsync(News), HttpStatusCode.OK);
        return [.. page.GetProperty("items").EnumerateArray().Select(i => i.GetProperty("slug").GetString()!)];
    }
}
