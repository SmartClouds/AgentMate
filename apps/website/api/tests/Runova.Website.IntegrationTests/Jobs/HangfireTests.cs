using System.Net;
using Hangfire;
using Hangfire.Storage;
using Microsoft.Extensions.DependencyInjection;
using Runova.Website.Api.Jobs;
using Runova.Website.Core.Identity;
using Runova.Website.IntegrationTests.Infrastructure;

namespace Runova.Website.IntegrationTests.Jobs;

public sealed class HangfireTests(PostgresFixture postgres) : IDisposable
{
    private const string Dashboard = "/hangfire";

    private readonly WebsiteApiFactory _factory = new(postgres.ConnectionString);

    public void Dispose() => _factory.Dispose();

    [Fact]
    public async Task The_dashboard_answers_401_when_signed_out()
    {
        var response = await _factory.CreateApiClient().GetAsync(Dashboard);

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.Unauthorized, ProblemAssert.Type("unauthorized"), Dashboard);
    }

    [Fact]
    public async Task The_dashboard_answers_403_for_an_Editor()
    {
        var editor = await TestUsers.SignedInClientAsync(_factory, await TestUsers.CreateAsync(_factory.Services, Roles.Editor));

        var response = await editor.GetAsync(Dashboard);

        await ProblemAssert.IsProblemAsync(response, HttpStatusCode.Forbidden, ProblemAssert.Type("forbidden"), Dashboard);
    }

    [Theory]
    [InlineData(Dashboard)]
    [InlineData(Dashboard + "/recurring")]
    public async Task The_dashboard_answers_200_for_an_Admin(string path)
    {
        var admin = await TestUsers.SignedInClientAsync(_factory, await TestUsers.CreateAsync(_factory.Services, Roles.Admin));

        var response = await admin.GetAsync(path);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("text/html", response.Content.Headers.ContentType?.MediaType);
    }

    [Fact]
    public void The_registry_schedules_every_recurring_job_on_start()
    {
        using var connection = _factory.Services.GetRequiredService<JobStorage>().GetConnection();

        var jobs = connection.GetRecurringJobs().Select(j => KeyValuePair.Create(j.Id, j.Cron)).OrderBy(j => j.Key);

        Assert.Equal(RecurringJobRegistry.Schedules.OrderBy(j => j.Key), jobs);
        Assert.Equal("0 * * * *", RecurringJobRegistry.Schedules[RecurringJobRegistry.InvitationsCleanup]);
    }
}
