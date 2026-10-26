using System.Net;
using System.Security.Cryptography;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Time.Testing;
using Runova.ServerCore.Alerts;
using Runova.ServerCore.Certificates;
using Runova.ServerCore.Certificates.Acme;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Jobs;
using Runova.ServerCore.Nginx;
using Runova.ServerCore.Security;
using Runova.ServerCore.Tests.Certificates.Acme;
using Runova.ServerCore.Tests.Nginx;
using Runova.ServerCore.Tests.Web;

namespace Runova.ServerCore.Tests.Certificates;

/// <summary>
/// E11 T3 to T5 and AC2 to AC4 against a fake CA: issuing as a job, the account key sealed, renewal
/// inside the ARI window with "replaces", backoff and an alert after failures, and plain errors.
/// </summary>
public sealed class CertificateServiceTests
{
    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private sealed class FakeAcmeHttp(HttpMessageHandler handler) : IAcmeHttp
    {
        public HttpClient Client { get; } = new(handler) { Timeout = Timeout.InfiniteTimeSpan };
    }

    private sealed class Ca : IAsyncDisposable
    {
        public required AuthHarness Harness { get; init; }

        public required FakeAcmeServer Server { get; init; }

        public required HubConnection Hub { get; init; }

        public FakeTimeProvider Clock => Harness.Clock!;

        public CertificateRenewals Renewals => Harness.Services.GetRequiredService<CertificateRenewals>();

        public async Task<SiteCertificate> RowAsync()
        {
            await using var scope = Harness.Services.CreateAsyncScope();
            return await scope.ServiceProvider.GetRequiredService<CoreDbContext>().Certificates.AsNoTracking().SingleAsync(Cancel);
        }

        public async ValueTask DisposeAsync()
        {
            await Hub.DisposeAsync();
            await Harness.DisposeAsync();
        }
    }

    /// <summary>Answers nothing, like a domain whose DNS points at another server.</summary>
    private sealed class ElsewherePublisher : IHttp01ChallengePublisher
    {
        public Task PublishAsync(string domain, string token, string keyAuthorization, CancellationToken cancellationToken) => Task.CompletedTask;

        public Task RemoveAsync(string domain, string token, CancellationToken cancellationToken) => Task.CompletedTask;
    }

    private static async Task<Ca> StartAsync(bool answerChallenges = true)
    {
        FakeAcmeServer? server = null;
        var http01 = new InMemoryHttp01ChallengePublisher();
        var harness = await AuthHarness.CreateAsync(CoreRoles.Admin, fakeClock: true, (services, clock) =>
        {
            server = new FakeAcmeServer(clock!, http01, new InMemoryDns01ChallengeHook());
            services.AddSingleton<IAcmeHttp>(new FakeAcmeHttp(server));
            services.AddSingleton<IHttp01ChallengePublisher>(answerChallenges ? http01 : new ElsewherePublisher());
            services.AddSingleton<IUpstreamResolver>(new FakeResolver());
            services.AddSingleton(new AcmeDirectoryChoice(FakeAcmeServer.DirectoryUrl, new Uri("https://staging.acme.test/directory")));
            services.AddSingleton(new CertificateRenewalOptions(RunInBackground: false));
        });
        var hub = await WebHubTests.ConnectAsync(harness);
        await WebHubTests.SetUpNginxAsync(harness, hub);
        Assert.Empty((await hub.InvokeAsync<SiteSaveResult>(nameof(ICoreHub.SaveSite), WebHubTests.Blog(), Cancel)).Problems);
        return new Ca { Harness = harness, Server = server!, Hub = hub };
    }

    private static async Task<JobInfo> IssueAsync(Ca ca, CertificateIssueRequest? request = null)
    {
        var job = await ca.Hub.InvokeAsync<JobInfo>(
            nameof(ICoreHub.IssueCertificate),
            request ?? new CertificateIssueRequest("blog", AcceptTermsOfService: true, ContactEmail: "ops@example.com"),
            Cancel);
        return await ca.Harness.Services.GetRequiredService<JobEngine>().WhenFinishedAsync(job.Id, Cancel).WaitAsync(TimeSpan.FromSeconds(30), Cancel);
    }

    [Fact]
    public async Task Issuing_is_a_job_that_validates_over_http01_stores_the_certificate_and_switches_the_site_to_https()
    {
        await using var ca = await StartAsync();

        var job = await IssueAsync(ca);

        Assert.True(job.State == JobState.Succeeded, job.Error);
        var log = new List<string>();
        await foreach (var item in ca.Harness.Services.GetRequiredService<JobEngine>().StreamAsync(job.Id, 0, Cancel))
        {
            log.AddRange(item.Lines.Select(line => line.Text));
        }

        Assert.Contains("Waiting for the CA to validate blog.example.com.", log);
        Assert.Contains("The site serves its new certificate.", log);
        var certificate = Assert.Single(await ca.Hub.InvokeAsync<CertificateInfo[]>(nameof(ICoreHub.ListCertificates), Cancel));
        Assert.Equal((CertificateSource.Acme, CertificateState.Valid, true, false), (certificate.Source, certificate.State, certificate.AutoRenew, certificate.Staging));
        var nginx = ca.Harness.Services.GetRequiredService<SimulatedNginxMachine>();
        Assert.Contains("ssl_certificate /etc/nginx/runova/certs/blog/fullchain.pem;", nginx.Text("/etc/nginx/runova/current/sites/blog.conf"), StringComparison.Ordinal);
        Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, nginx.ModeOf("/etc/nginx/runova/certs/blog/privkey.pem"));
        Assert.True((await ca.Hub.InvokeAsync<SiteInfo[]>(nameof(ICoreHub.ListSites), Cancel))[0].Applied);
    }

    [Fact]
    public async Task The_account_and_certificate_keys_are_stored_sealed()
    {
        await using var ca = await StartAsync();
        await IssueAsync(ca);

        await using var scope = ca.Harness.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<CoreDbContext>();
        var account = await db.AcmeAccounts.SingleAsync(Cancel);
        var row = await db.Certificates.SingleAsync(Cancel);

        foreach (var sealedKey in new[] { account.ProtectedKey, row.ProtectedKey })
        {
            using var key = ECDsa.Create();
            Assert.ThrowsAny<CryptographicException>(() => key.ImportPkcs8PrivateKey(Convert.FromBase64String(sealedKey), out _));
        }

        var keys = ca.Harness.Services.GetRequiredService<CertificateKeys>();
        using var account2 = ECDsa.Create();
        account2.ImportPkcs8PrivateKey(keys.UnprotectAccountKey(account.ProtectedKey), out _);
        Assert.Throws<CryptographicException>(() => keys.UnprotectCertificateKey(account.ProtectedKey));
    }

    [Fact]
    public async Task Without_accepting_the_terms_the_first_issue_fails_and_says_so()
    {
        await using var ca = await StartAsync();

        var job = await IssueAsync(ca, new CertificateIssueRequest("blog"));

        Assert.Equal(JobState.Failed, job.State);
        Assert.Contains("terms of service", job.Error, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_validation_failure_is_explained_in_words_a_person_can_act_on()
    {
        await using var ca = await StartAsync(answerChallenges: false);

        var job = await IssueAsync(ca);

        Assert.Equal(JobState.Failed, job.State);
        Assert.Contains("blog.example.com answered the CA from somewhere else", job.Error, StringComparison.Ordinal);
        Assert.Contains("answered the CA from somewhere else", (await ca.Hub.InvokeAsync<CertificateInfo[]>(nameof(ICoreHub.ListCertificates), Cancel)).SingleOrDefault()?.LastError ?? job.Error, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("dns", "does not point here")]
    [InlineData("connection", "port 80")]
    [InlineData("incorrectResponse", "answered the CA from somewhere else")]
    [InlineData("caa", "CAA record")]
    public void Validation_errors_become_plain_advice(string type, string expected)
    {
        var problem = new AcmeProblem("urn:ietf:params:acme:error:" + type) { Detail = "what the CA saw" };

        var message = CertificateService.Describe(AcmeValidationException.Create("blog.example.com", "http-01", problem));

        Assert.Contains(expected, message, StringComparison.Ordinal);
        Assert.Contains("blog.example.com", message, StringComparison.Ordinal);
    }

    [Fact]
    public void A_rate_limit_says_when_to_try_again()
    {
        var at = new DateTimeOffset(2026, 10, 2, 8, 0, 0, TimeSpan.Zero);
        var limited = AcmeProblemException.Create("Ordering", new AcmeProblem("urn:ietf:params:acme:error:rateLimited") { Detail = "too many" }, HttpStatusCode.TooManyRequests, at);

        Assert.Contains("2026-10-02 08:00:00Z", CertificateService.Describe(limited), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Renewal_waits_for_the_ari_window_renews_inside_it_and_sends_replaces()
    {
        await using var ca = await StartAsync();
        await IssueAsync(ca);
        var first = await ca.RowAsync();

        Assert.Equal(0, await ca.Renewals.RunOnceAsync(Cancel));
        var planned = await ca.RowAsync();
        Assert.InRange(planned.RenewAt!.Value, planned.WindowStart!.Value, planned.WindowEnd!.Value);
        Assert.True(planned.WindowStart > first.NotBefore + (long)TimeSpan.FromDays(50).TotalMilliseconds);

        // Six hours later the window is the same, so the planned moment stays.
        ca.Clock.Advance(TimeSpan.FromHours(7));
        Assert.Equal(0, await ca.Renewals.RunOnceAsync(Cancel));
        Assert.Equal(planned.RenewAt, (await ca.RowAsync()).RenewAt);

        ca.Clock.Advance(DateTimeOffset.FromUnixTimeMilliseconds(planned.WindowEnd.Value) - ca.Clock.GetUtcNow() + TimeSpan.FromMinutes(1));
        Assert.Equal(1, await ca.Renewals.RunOnceAsync(Cancel));

        var renewed = await ca.RowAsync();
        Assert.NotEqual(first.CertificateId, renewed.CertificateId);
        Assert.Equal(first.CertificateId, renewed.Replaced);
        Assert.Null(renewed.RenewAt);
        Assert.Contains(ca.Server.RequestsTo("/new-order"), request => request.Payload?.ToString().Contains(first.CertificateId!, StringComparison.Ordinal) == true);
    }

    [Fact]
    public async Task A_failing_renewal_backs_off_raises_an_alert_and_clears_it_once_it_works()
    {
        await using var ca = await StartAsync();
        await IssueAsync(ca);
        await ca.Renewals.RunOnceAsync(Cancel);
        ca.Server.Intercept = (request, _) => Task.FromResult(request.Path.EndsWith("new-order", StringComparison.Ordinal)
            ? FakeAcmeServer.ProblemResponse(HttpStatusCode.InternalServerError, "serverInternal", "The CA is down")
            : null);
        var due = DateTimeOffset.FromUnixTimeMilliseconds((await ca.RowAsync()).WindowEnd!.Value);
        ca.Clock.Advance(due - ca.Clock.GetUtcNow() + TimeSpan.FromMinutes(1));

        await ca.Renewals.RunOnceAsync(Cancel);
        var once = await ca.RowAsync();
        await ca.Renewals.RunOnceAsync(Cancel);
        var skipped = await ca.RowAsync();
        ca.Clock.Advance(CertificateService.FirstBackoff + TimeSpan.FromMinutes(1));
        await ca.Renewals.RunOnceAsync(Cancel);
        var twice = await ca.RowAsync();

        Assert.Equal(1, once.FailedAttempts);
        Assert.Equal(ca.Clock.GetUtcNow().ToUnixTimeMilliseconds() - (long)TimeSpan.FromMinutes(61).TotalMilliseconds + (long)CertificateService.FirstBackoff.TotalMilliseconds, once.NextAttemptAt);
        Assert.Equal(1, skipped.FailedAttempts);
        Assert.Equal(2, twice.FailedAttempts);
        Assert.Equal(ca.Clock.GetUtcNow().ToUnixTimeMilliseconds() + (long)(CertificateService.FirstBackoff * 2).TotalMilliseconds, twice.NextAttemptAt);
        Assert.Contains("The CA is down", twice.LastError, StringComparison.Ordinal);
        var alerts = ca.Harness.Services.GetRequiredService<AlertCenter>();
        var alert = Assert.Single(await alerts.OpenAsync(AlertKind.CertificateRenewalFailed, Cancel));
        Assert.Equal(("blog", AlertSeverity.Warning, 2), (alert.Resource, alert.Severity, alert.Occurrences));

        ca.Server.Intercept = null;
        ca.Clock.Advance(CertificateService.FirstBackoff * 2 + TimeSpan.FromMinutes(1));
        Assert.Equal(1, await ca.Renewals.RunOnceAsync(Cancel));
        Assert.Empty(await alerts.OpenAsync(AlertKind.CertificateRenewalFailed, Cancel));
        Assert.Equal(0, (await ca.RowAsync()).FailedAttempts);
    }

    [Fact]
    public async Task Without_ari_renewal_is_planned_two_thirds_into_the_lifetime()
    {
        await using var ca = await StartAsync();
        ca.Server.OfferRenewalInfo = false;
        await IssueAsync(ca);

        await ca.Renewals.RunOnceAsync(Cancel);

        var row = await ca.RowAsync();
        Assert.Equal(row.NotBefore + ((row.NotAfter - row.NotBefore) * 2 / 3), row.RenewAt);
    }

    [Fact]
    public async Task Revoking_asks_the_ca_and_takes_the_certificate_off_the_site()
    {
        await using var ca = await StartAsync();
        await IssueAsync(ca);
        var id = (await ca.RowAsync()).CertificateId!;
        await ca.Hub.InvokeAsync<StepUpResponse>(nameof(ICoreHub.StepUp), new StepUpRequest(AuthHarness.Password), Cancel);

        var removed = await ca.Hub.InvokeAsync<NginxApplyResult>(nameof(ICoreHub.RemoveCertificate), new CertificateRemoveRequest("blog", Revoke: true, CertificateRevocationReason.Superseded), Cancel);

        Assert.True(removed.Applied);
        Assert.True(ca.Server.IsRevoked(id));
        Assert.Empty(await ca.Hub.InvokeAsync<CertificateInfo[]>(nameof(ICoreHub.ListCertificates), Cancel));
    }
}
