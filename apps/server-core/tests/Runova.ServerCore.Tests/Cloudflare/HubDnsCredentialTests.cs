using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
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

namespace Runova.ServerCore.Tests.Cloudflare;

/// <summary>
/// E14 T7: a zone-scoped DNS token sent to the server is checked with Cloudflare, kept sealed and
/// never returned; with it, a wildcard certificate is issued over DNS-01 through Cloudflare (the
/// hook E11 left open), and without it issuing says what to do.
/// </summary>
public sealed class HubDnsCredentialTests
{
    private const string ZoneId = "023e105f4ecef8ad9ca31a8372d0c353";
    private const string Token = "Gm4pR2e6Tq9VxYb1Lk0NsHjW3cZaDf7U8iOoPl5M";

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private sealed class FakeAcmeHttp(HttpMessageHandler handler) : IAcmeHttp
    {
        public HttpClient Client { get; } = new(handler) { Timeout = Timeout.InfiniteTimeSpan };
    }

    private static Task<DnsCredentialSaveResult> SaveAsync(HubConnection hub, string token = Token, string zone = "Example.com") =>
        hub.InvokeAsync<DnsCredentialSaveResult>(nameof(ICoreHub.SaveDnsCredential), new DnsCredentialRequest(zone, ZoneId, token), Cancel);

    [Fact]
    public async Task A_token_is_checked_stored_sealed_and_never_returned()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Admin);
        await using var hub = await WebHubTests.ConnectAsync(harness);

        var refused = await SaveAsync(hub, token: "denied-Gm4pR2e6Tq9VxYb1Lk0N");
        var saved = await SaveAsync(hub);
        var listed = await hub.InvokeAsync<DnsCredentialInfo[]>(nameof(ICoreHub.ListDnsCredentials), Cancel);

        Assert.Contains("Zone > DNS > Edit", Assert.Single(refused.Problems), StringComparison.Ordinal);
        Assert.Empty(saved.Problems);
        var credential = Assert.Single(listed);
        Assert.Equal(("example.com", ZoneId, "cloudflare", "maria"), (credential.Zone, credential.ZoneId, credential.Provider, credential.CreatedBy));

        await using var scope = harness.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<CoreDbContext>();
        var row = await db.DnsCredentials.AsNoTracking().SingleAsync(Cancel);
        Assert.DoesNotContain(Token, row.ProtectedToken, StringComparison.Ordinal);
        var audit = string.Join('\n', await db.AuditEvents.AsNoTracking().Select(e => e.Action + " " + e.Target + " " + e.Parameters).ToListAsync(Cancel));
        Assert.Contains("cloudflare.dns-token.save example.com", audit, StringComparison.Ordinal);
        Assert.DoesNotContain(Token, audit, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("*.example.com", ZoneId, Token)]
    [InlineData("example.com", "not-an-id", Token)]
    [InlineData("example.com", ZoneId, "short")]
    [InlineData("exa mple.com", ZoneId, Token)]
    public async Task Malformed_requests_are_refused_before_cloudflare_is_asked(string zone, string zoneId, string token)
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Admin);
        await using var hub = await WebHubTests.ConnectAsync(harness);

        var result = await hub.InvokeAsync<DnsCredentialSaveResult>(nameof(ICoreHub.SaveDnsCredential), new DnsCredentialRequest(zone, zoneId, token), Cancel);

        Assert.NotEmpty(result.Problems);
        Assert.Empty(harness.Services.GetRequiredService<FakeCloudflareApi>().Calls);
    }

    [Fact]
    public async Task Removing_a_token_forgets_it_and_an_operator_cannot_send_one()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Admin);
        await using var hub = await WebHubTests.ConnectAsync(harness);
        await SaveAsync(hub);

        await hub.InvokeAsync(nameof(ICoreHub.RemoveDnsCredential), "example.com", Cancel);
        var again = await Assert.ThrowsAsync<HubException>(() => hub.InvokeAsync(nameof(ICoreHub.RemoveDnsCredential), "example.com", Cancel));

        Assert.Empty(await hub.InvokeAsync<DnsCredentialInfo[]>(nameof(ICoreHub.ListDnsCredentials), Cancel));
        Assert.Contains("no DNS token", again.Message, StringComparison.Ordinal);

        await using var operatorHarness = await AuthHarness.CreateAsync(CoreRoles.Operator);
        await using var operatorHub = await WebHubTests.ConnectAsync(operatorHarness);
        var refused = await Assert.ThrowsAsync<HubException>(() => SaveAsync(operatorHub));
        Assert.Contains("unauthorized", refused.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task A_wildcard_is_issued_over_dns01_with_the_zone_token_and_refused_without_it()
    {
        var dns01 = new InMemoryDns01ChallengeHook();
        FakeAcmeServer? server = null;
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Admin, fakeClock: true, (services, clock) =>
        {
            server = new FakeAcmeServer(clock!, new InMemoryHttp01ChallengePublisher(), dns01);
            services.AddSingleton<IAcmeHttp>(new FakeAcmeHttp(server));
            services.AddSingleton<IUpstreamResolver>(new FakeResolver());
            services.AddSingleton(new AcmeDirectoryChoice(FakeAcmeServer.DirectoryUrl, new Uri("https://staging.acme.test/directory")));
            services.AddSingleton(new CertificateRenewalOptions(RunInBackground: false));
        });
        var api = harness.Services.GetRequiredService<FakeCloudflareApi>();
        api.Mirror = dns01;
        await using var hub = await WebHubTests.ConnectAsync(harness);
        await WebHubTests.SetUpNginxAsync(harness, hub);
        var site = WebHubTests.Blog() with { Id = "wild", Domains = ["example.com", "*.example.com"] };
        Assert.Empty((await hub.InvokeAsync<SiteSaveResult>(nameof(ICoreHub.SaveSite), site, Cancel)).Problems);
        var request = new CertificateIssueRequest("wild", AcceptTermsOfService: true);
        var jobs = harness.Services.GetRequiredService<JobEngine>();

        var without = await jobs.WhenFinishedAsync((await hub.InvokeAsync<JobInfo>(nameof(ICoreHub.IssueCertificate), request, Cancel)).Id, Cancel).WaitAsync(TimeSpan.FromSeconds(30), Cancel);
        Assert.Empty((await SaveAsync(hub)).Problems);
        var with = await jobs.WhenFinishedAsync((await hub.InvokeAsync<JobInfo>(nameof(ICoreHub.IssueCertificate), request, Cancel)).Id, Cancel).WaitAsync(TimeSpan.FromSeconds(30), Cancel);

        Assert.Equal(JobState.Failed, without.State);
        Assert.Contains("send this server a DNS token for the zone", without.Error, StringComparison.Ordinal);
        Assert.True(with.State == JobState.Succeeded, with.Error);
        Assert.Contains(api.Calls, call => call.Call == "create _acme-challenge.example.com" && call.Token == Token && call.ZoneId == ZoneId);
        Assert.Empty(api.Records);
        var certificate = Assert.Single(await hub.InvokeAsync<CertificateInfo[]>(nameof(ICoreHub.ListCertificates), Cancel));
        Assert.Equal(["example.com", "*.example.com"], certificate.Domains);
        Assert.NotNull(Assert.Single(await hub.InvokeAsync<DnsCredentialInfo[]>(nameof(ICoreHub.ListDnsCredentials), Cancel)).LastUsedAtUnixMs);
    }

    [Fact]
    public async Task Asking_for_dns01_on_a_name_without_a_token_says_what_to_do()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Admin);
        await using var hub = await WebHubTests.ConnectAsync(harness);
        await WebHubTests.SetUpNginxAsync(harness, hub);
        Assert.Empty((await hub.InvokeAsync<SiteSaveResult>(nameof(ICoreHub.SaveSite), WebHubTests.Blog(), Cancel)).Problems);

        var job = await hub.InvokeAsync<JobInfo>(nameof(ICoreHub.IssueCertificate), new CertificateIssueRequest("blog", AcceptTermsOfService: true, PreferDns01: true), Cancel);
        var done = await harness.Services.GetRequiredService<JobEngine>().WhenFinishedAsync(job.Id, Cancel).WaitAsync(TimeSpan.FromSeconds(30), Cancel);

        Assert.Equal(JobState.Failed, done.State);
        Assert.StartsWith("DNS-01 was asked for", done.Error, StringComparison.Ordinal);
    }
}
