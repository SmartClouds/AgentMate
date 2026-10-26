using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Data;
using Runova.ServerCore.Jobs;
using Runova.ServerCore.Nginx;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Tests.Web;

/// <summary>Websites through the hub, against a simulated nginx: save, apply, snippets, logs and uploaded certificates.</summary>
public sealed class WebHubTests
{
    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    internal static SiteSettings Blog(string domain = "blog.example.com") =>
        new("blog", [domain], new UpstreamTarget(UpstreamKind.ServicePort, Port: 3000, Service: "web"), Websocket: true);

    internal static async Task<HubConnection> ConnectAsync(AuthHarness harness)
    {
        var signedIn = await harness.SignInAsync();
        var hub = harness.Hub(signedIn.AccessToken);
        await hub.StartAsync(Cancel);
        return hub;
    }

    /// <summary>Runs the install job (adopting the simulated nginx) and waits for it.</summary>
    internal static async Task SetUpNginxAsync(AuthHarness harness, HubConnection hub)
    {
        var job = await hub.InvokeAsync<JobInfo>(nameof(ICoreHub.InstallNginx), Cancel);
        var done = await harness.Services.GetRequiredService<JobEngine>().WhenFinishedAsync(job.Id, Cancel).WaitAsync(TimeSpan.FromSeconds(30), Cancel);
        Assert.True(done.State == JobState.Succeeded, done.Error);
    }

    [Fact]
    public async Task A_saved_site_waits_until_it_is_applied_and_then_nginx_serves_it()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Admin);
        await using var hub = await ConnectAsync(harness);
        await SetUpNginxAsync(harness, hub);
        var nginx = harness.Services.GetRequiredService<SimulatedNginxMachine>();

        var saved = await hub.InvokeAsync<SiteSaveResult>(nameof(ICoreHub.SaveSite), Blog("Blog.Example.com"), Cancel);
        var pending = await hub.InvokeAsync<NginxStatus>(nameof(ICoreHub.GetNginxStatus), Cancel);
        var applied = await hub.InvokeAsync<NginxApplyResult>(nameof(ICoreHub.ApplyNginx), Cancel);
        var status = await hub.InvokeAsync<NginxStatus>(nameof(ICoreHub.GetNginxStatus), Cancel);
        var sites = await hub.InvokeAsync<SiteInfo[]>(nameof(ICoreHub.ListSites), Cancel);

        Assert.Empty(saved.Problems);
        Assert.Equal(["blog.example.com"], saved.Site!.Settings.Domains);
        Assert.False(saved.Site.Applied);
        Assert.True(pending.PendingChanges);
        Assert.True(applied.Applied, string.Join("; ", applied.Problems.Select(p => p.Message)));
        Assert.Equal((false, true, 2, "maria"), (status.PendingChanges, status.Managed, status.CurrentRelease, status.LastAppliedBy));
        Assert.True(Assert.Single(sites).Applied);
        Assert.Contains("proxy_pass http://127.0.0.1:3000;", nginx.Text("/etc/nginx/runova/current/sites/blog.conf"), StringComparison.Ordinal);
        Assert.Equal(["nginx.install", "site.save", "nginx.apply"], await ActionsAsync(harness, "nginx.", "site."));
    }

    [Fact]
    public async Task A_site_with_problems_is_not_saved_and_each_problem_names_its_field()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Admin);
        await using var hub = await ConnectAsync(harness);
        await hub.InvokeAsync<SiteSaveResult>(nameof(ICoreHub.SaveSite), Blog(), Cancel);

        var clash = await hub.InvokeAsync<SiteSaveResult>(
            nameof(ICoreHub.SaveSite),
            Blog() with { Id = "shop", Upstream = new UpstreamTarget(UpstreamKind.Url, Address: "http://169.254.169.254/") },
            Cancel);

        Assert.Null(clash.Site);
        Assert.Equal(["sites[shop].domains[0]", "sites[shop].upstream"], clash.Problems.Select(p => p.Field));
        Assert.All(clash.Problems, p => Assert.Equal("shop", p.SiteId));
        Assert.Single(await hub.InvokeAsync<SiteInfo[]>(nameof(ICoreHub.ListSites), Cancel));
    }

    [Fact]
    public async Task Basic_auth_passwords_are_hashed_never_sent_back_and_kept_when_left_out()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Admin);
        await using var hub = await ConnectAsync(harness);
        var withAuth = Blog() with { BasicAuth = new SiteBasicAuth([new SiteBasicAuthUser("ana", "a long secret phrase")]) };

        var first = await hub.InvokeAsync<SiteSaveResult>(nameof(ICoreHub.SaveSite), withAuth, Cancel);
        var hash = await HashesAsync(harness);
        var again = await hub.InvokeAsync<SiteSaveResult>(nameof(ICoreHub.SaveSite), withAuth with { BasicAuth = new SiteBasicAuth([new SiteBasicAuthUser("ana")]) }, Cancel);
        var stranger = await hub.InvokeAsync<SiteSaveResult>(nameof(ICoreHub.SaveSite), withAuth with { BasicAuth = new SiteBasicAuth([new SiteBasicAuthUser("bo")]) }, Cancel);

        Assert.Null(first.Site!.Settings.BasicAuth!.Users[0].Password);
        Assert.StartsWith("{\"ana\":\"$6$", hash, StringComparison.Ordinal);
        Assert.True(Sha512Crypt.Verify("a long secret phrase", System.Text.Json.JsonDocument.Parse(hash!).RootElement.GetProperty("ana").GetString()!));
        Assert.Empty(again.Problems);
        Assert.Equal(hash, await HashesAsync(harness));
        Assert.Equal("sites[blog].basicAuth.users[0].password", Assert.Single(stranger.Problems).Field);
        var audit = await AuditParametersAsync(harness);
        Assert.DoesNotContain("secret phrase", audit, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Only_the_owner_sets_snippets_and_a_refused_directive_points_at_its_line()
    {
        await using var owner = await AuthHarness.CreateAsync(CoreRoles.Owner);
        await using var hub = await ConnectAsync(owner);
        await hub.InvokeAsync<SiteSaveResult>(nameof(ICoreHub.SaveSite), Blog(), Cancel);

        var refused = await hub.InvokeAsync<SiteSaveResult>(nameof(ICoreHub.SetSiteSnippets), new SiteSnippets("blog", "gzip on;\ninclude /etc/shadow;\n"), Cancel);
        var accepted = await hub.InvokeAsync<SiteSaveResult>(nameof(ICoreHub.SetSiteSnippets), new SiteSnippets("blog", LocationSnippet: "add_header X-Test yes;\n"), Cancel);

        var problem = Assert.Single(refused.Problems);
        Assert.Equal(("sites[blog].serverSnippet", 2), (problem.Field, problem.Line));
        Assert.Equal("add_header X-Test yes;\n", accepted.Site!.LocationSnippet);

        await using var admin = await AuthHarness.CreateAsync(CoreRoles.Admin);
        await using var adminHub = await ConnectAsync(admin);
        await adminHub.InvokeAsync<SiteSaveResult>(nameof(ICoreHub.SaveSite), Blog(), Cancel);
        var denied = await Assert.ThrowsAsync<HubException>(() =>
            adminHub.InvokeAsync<SiteSaveResult>(nameof(ICoreHub.SetSiteSnippets), new SiteSnippets("blog", "gzip on;\n"), Cancel));
        Assert.Contains("unauthorized", denied.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task A_sites_log_comes_back_as_its_last_lines()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Admin);
        await using var hub = await ConnectAsync(harness);
        await hub.InvokeAsync<SiteSaveResult>(nameof(ICoreHub.SaveSite), Blog(), Cancel);
        var nginx = harness.Services.GetRequiredService<SimulatedNginxMachine>();
        nginx.WriteText("/var/log/nginx/runova-blog.access.log", string.Concat(Enumerable.Range(1, 30).Select(i => $"203.0.113.{i} - - \"GET /{i} HTTP/1.1\" 200\n")));

        var batches = new List<SiteLogBatch>();
        await foreach (var batch in hub.StreamAsync<SiteLogBatch>(nameof(ICoreHub.StreamSiteLog), new SiteLogRequest("blog", SiteLogKind.Access, TailLines: 5, Follow: false), Cancel))
        {
            batches.Add(batch);
        }

        var lines = batches.SelectMany(b => b.Lines).ToList();
        Assert.Equal(5, lines.Count);
        Assert.StartsWith("203.0.113.26 ", lines[0], StringComparison.Ordinal);
        Assert.StartsWith("203.0.113.30 ", lines[^1], StringComparison.Ordinal);
        await Assert.ThrowsAsync<HubException>(async () =>
        {
            await foreach (var _ in hub.StreamAsync<SiteLogBatch>(nameof(ICoreHub.StreamSiteLog), new SiteLogRequest("../../etc", SiteLogKind.Error, Follow: false), Cancel))
            {
            }
        });
    }

    [Fact]
    public async Task An_uploaded_certificate_is_checked_stored_sealed_and_served_and_removing_it_needs_a_step_up()
    {
        await using var harness = await AuthHarness.CreateAsync(CoreRoles.Admin);
        await using var hub = await ConnectAsync(harness);
        await SetUpNginxAsync(harness, hub);
        await hub.InvokeAsync<SiteSaveResult>(nameof(ICoreHub.SaveSite), Blog(), Cancel);
        var (chain, key) = SelfSigned("blog.example.com");
        var (otherChain, _) = SelfSigned("other.example.com");
        var nginx = harness.Services.GetRequiredService<SimulatedNginxMachine>();

        var mismatch = await hub.InvokeAsync<CertificateUploadResult>(nameof(ICoreHub.UploadCertificate), new CertificateUploadRequest("blog", otherChain, key), Cancel);
        var uploaded = await hub.InvokeAsync<CertificateUploadResult>(nameof(ICoreHub.UploadCertificate), new CertificateUploadRequest("blog", chain, key), Cancel);

        Assert.Contains("does not belong", Assert.Single(mismatch.Problems), StringComparison.Ordinal);
        Assert.Empty(uploaded.Problems);
        Assert.True(uploaded.Apply!.Applied);
        Assert.Equal((CertificateSource.Uploaded, CertificateState.Valid, false), (uploaded.Certificate!.Source, uploaded.Certificate.State, uploaded.Certificate.AutoRenew));
        Assert.Contains("listen 443 ssl;", nginx.Text("/etc/nginx/runova/current/sites/blog.conf"), StringComparison.Ordinal);
        Assert.Contains("BEGIN PRIVATE KEY", nginx.Text("/etc/nginx/runova/certs/blog/privkey.pem"), StringComparison.Ordinal);
        await using (var scope = harness.Services.CreateAsyncScope())
        {
            var row = await scope.ServiceProvider.GetRequiredService<CoreDbContext>().Certificates.SingleAsync(Cancel);
            Assert.DoesNotContain("PRIVATE KEY", row.ProtectedKey, StringComparison.Ordinal);
            Assert.Equal(1, CountOf(row.ChainPem, "BEGIN CERTIFICATE"));
        }

        var unconfirmed = await Assert.ThrowsAsync<HubException>(() =>
            hub.InvokeAsync<NginxApplyResult>(nameof(ICoreHub.RemoveCertificate), new CertificateRemoveRequest("blog"), Cancel));
        Assert.Contains("unauthorized", unconfirmed.Message, StringComparison.OrdinalIgnoreCase);
        await hub.InvokeAsync<StepUpResponse>(nameof(ICoreHub.StepUp), new StepUpRequest(AuthHarness.Password), Cancel);
        var removed = await hub.InvokeAsync<NginxApplyResult>(nameof(ICoreHub.RemoveCertificate), new CertificateRemoveRequest("blog"), Cancel);

        Assert.True(removed.Applied);
        Assert.DoesNotContain("listen 443", nginx.Text("/etc/nginx/runova/current/sites/blog.conf"), StringComparison.Ordinal);
        Assert.False(nginx.Exists("/etc/nginx/runova/certs/blog"));
        Assert.Empty(await hub.InvokeAsync<CertificateInfo[]>(nameof(ICoreHub.ListCertificates), Cancel));
    }

    internal static (string Chain, string Key) SelfSigned(string domain)
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var request = new CertificateRequest($"CN={domain}", key, HashAlgorithmName.SHA256);
        var names = new SubjectAlternativeNameBuilder();
        names.AddDnsName(domain);
        request.CertificateExtensions.Add(names.Build());
        using var certificate = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(60));
        return (certificate.ExportCertificatePem(), key.ExportPkcs8PrivateKeyPem());
    }

    private static int CountOf(string text, string part) => text.Split(part).Length - 1;

    private static async Task<string?> HashesAsync(AuthHarness harness)
    {
        await using var scope = harness.Services.CreateAsyncScope();
        return (await scope.ServiceProvider.GetRequiredService<CoreDbContext>().Sites.AsNoTracking().SingleAsync(Cancel)).BasicAuthHashes;
    }

    private static async Task<string> AuditParametersAsync(AuthHarness harness)
    {
        await using var scope = harness.Services.CreateAsyncScope();
        var events = await scope.ServiceProvider.GetRequiredService<CoreDbContext>().AuditEvents.AsNoTracking().ToListAsync(Cancel);
        return string.Join('\n', events.Select(e => e.Parameters + " " + e.Target));
    }

    private static async Task<string[]> ActionsAsync(AuthHarness harness, params string[] prefixes)
    {
        await using var scope = harness.Services.CreateAsyncScope();
        var actions = await scope.ServiceProvider.GetRequiredService<CoreDbContext>().AuditEvents.AsNoTracking().OrderBy(e => e.Id).Select(e => e.Action).ToListAsync(Cancel);
        return [.. actions.Where(action => prefixes.Any(prefix => action.StartsWith(prefix, StringComparison.Ordinal)))];
    }
}
