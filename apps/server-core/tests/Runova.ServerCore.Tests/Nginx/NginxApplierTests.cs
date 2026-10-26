using System.Net;
using System.Text.Json;
using Runova.ServerCore.Nginx;

namespace Runova.ServerCore.Tests.Nginx;

/// <summary>
/// E10 T5 and AC2: a new release goes live only once nginx -t passes and new workers run it;
/// anything else leaves nginx on the release it ran, and a core that stopped halfway finishes or
/// undoes the apply when it starts again.
/// </summary>
public sealed class NginxApplierTests
{
    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private static NginxSite Site(string id = "app", string domain = "app.example.com") =>
        new() { Id = id, Domains = [domain], Upstream = new NginxServiceUpstream("web", 3000) };

    private static NginxConfiguration Config(params NginxSite[] sites) => new(sites, []);

    private static async Task<NginxKit> ReadyAsync()
    {
        var kit = new NginxKit();
        await kit.SetUpAsync();
        return kit;
    }

    [Fact]
    public async Task A_valid_configuration_becomes_the_next_release_and_nginx_runs_it()
    {
        using var kit = await ReadyAsync();
        var workers = kit.Machine.Workers;

        var outcome = await kit.ApplyAsync(Config(Site()));

        Assert.True(outcome.Applied, string.Join("; ", outcome.Problems));
        Assert.Equal(2, outcome.Release);
        Assert.Equal("releases/2", await kit.Machine.ReadLinkAsync(kit.Layout.CurrentLink, Cancel));
        Assert.Contains("server_name app.example.com;", kit.Machine.Text(kit.Layout.CurrentLink + "/sites/app.conf"), StringComparison.Ordinal);
        Assert.NotEqual(workers, kit.Machine.Workers);
        Assert.False(kit.Machine.Exists(kit.Layout.ApplyMarker));
    }

    [Fact]
    public async Task A_snippet_nginx_refuses_leaves_the_old_release_and_points_at_the_snippet_line()
    {
        using var kit = await ReadyAsync();
        await kit.ApplyAsync(Config(Site()));
        kit.Machine.TestFailure = machine => machine.Exists(kit.Layout.ReleaseDirectory(3))
            ? "nginx: [emerg] \"expires\" directive invalid value in /etc/nginx/runova/releases/3/snippets/app.location.conf:2"
            : null;

        var outcome = await kit.ApplyAsync(Config(Site() with { LocationSnippet = "gzip on;\nexpires sometimes;\n" }));

        Assert.False(outcome.Applied);
        var problem = Assert.Single(outcome.Problems);
        Assert.Equal(("sites[app].locationSnippet", 2), (problem.Field, problem.Line));
        Assert.Equal("releases/2", await kit.Machine.ReadLinkAsync(kit.Layout.CurrentLink, Cancel));
        Assert.False(kit.Machine.Exists(kit.Layout.ReleaseDirectory(3)));
        Assert.False(kit.Machine.Exists(kit.Layout.ApplyMarker));
        Assert.Equal(2, kit.Machine.Reloads);
    }

    [Fact]
    public async Task A_reload_nginx_does_not_take_is_rolled_back_with_the_reason_from_error_log()
    {
        using var kit = await ReadyAsync();
        kit.Machine.ReloadFailure = _ => "2026/10/01 12:00:01 [emerg] 4100#4100: bind() to 0.0.0.0:8443 failed (98: Address already in use)";
        var workers = kit.Machine.Workers;

        var outcome = await kit.ApplyAsync(Config(Site()));

        Assert.False(outcome.Applied);
        Assert.Equal(("nginx", "bind() to 0.0.0.0:8443 failed (98: Address already in use)"), (outcome.Problems[0].Field, outcome.Problems[0].Message));
        Assert.Equal("releases/1", await kit.Machine.ReadLinkAsync(kit.Layout.CurrentLink, Cancel));
        Assert.False(kit.Machine.Exists(kit.Layout.ReleaseDirectory(2)));
        Assert.Equal(workers, kit.Machine.Workers);
        // Once for the new release, once more after moving back, so nothing half-loaded stays.
        Assert.Equal(3, kit.Machine.Reloads);
    }

    [Fact]
    public async Task A_refused_reload_is_over_before_the_apply_returns_so_the_next_apply_gets_no_stale_error()
    {
        // nginx retries a bind() in use five times, 500 ms apart, writing the error each time. An
        // apply that returned at the first line left the rest to land in the next reload's window,
        // which then reported this port as its own cause (nightly run 37097759993).
        using var kit = await ReadyAsync();
        kit.Machine.BindRetries = 4;
        kit.Machine.BindRetryInterval = TimeSpan.FromMilliseconds(100);
        kit.Machine.ReloadFailure = machine => machine.Exists(kit.Layout.CurrentLink + "/sites/taken.conf")
            ? "2026/10/01 12:00:01 [emerg] 4100#4100: bind() to 0.0.0.0:3000 failed (98: Address already in use)"
            : null;

        var refused = await kit.ApplyAsync(Config(Site("taken", "taken.example.com")));
        var next = await kit.ApplyAsync(Config(Site()));

        Assert.True(next.Applied, string.Join("; ", next.Problems));
        Assert.False(refused.Applied);
        Assert.Equal(
            ["bind() to 0.0.0.0:3000 failed (98: Address already in use)", "still could not bind()"],
            refused.Problems.Select(problem => problem.Message));
        Assert.Equal("releases/2", await kit.Machine.ReadLinkAsync(kit.Layout.CurrentLink, Cancel));
    }

    [Fact]
    public async Task Nothing_reaches_nginx_when_the_model_is_refused()
    {
        using var kit = await ReadyAsync();
        var commands = kit.Machine.Commands.Count(command => command != "nginx -V");

        var outcome = await kit.ApplyAsync(Config(Site() with { ServerSnippet = "include /etc/shadow;\n" }));

        Assert.False(outcome.Applied);
        Assert.Equal(("sites[app].serverSnippet", 1), (outcome.Problems[0].Field, outcome.Problems[0].Line));
        Assert.Equal(commands, kit.Machine.Commands.Count(command => command != "nginx -V"));
        Assert.False(kit.Machine.Exists(kit.Layout.ReleaseDirectory(2)));
    }

    [Theory]
    [InlineData("169.254.169.254", "link-local")]
    [InlineData("fd00:ec2::254", "AWS")]
    public async Task An_upstream_name_that_resolves_to_a_refused_address_is_refused(string address, string reason)
    {
        using var kit = await ReadyAsync();
        kit.Resolver.Names["sneaky.example.net"] = [IPAddress.Parse(address)];

        var outcome = await kit.ApplyAsync(Config(Site() with { Upstream = new NginxUrlUpstream("http://sneaky.example.net:8080") }));

        var problem = Assert.Single(outcome.Problems);
        Assert.Equal("sites[app].upstream", problem.Field);
        Assert.Contains(reason, problem.Message, StringComparison.Ordinal);
        Assert.Equal("releases/1", await kit.Machine.ReadLinkAsync(kit.Layout.CurrentLink, Cancel));
    }

    [Fact]
    public async Task Names_in_snippet_proxy_pass_and_stream_endpoints_are_resolved_and_checked_too()
    {
        using var kit = await ReadyAsync();
        kit.Resolver.Names["api.internal.example"] = [IPAddress.Parse("10.0.0.7")];
        var stream = new NginxStreamProxy
        {
            Id = "db",
            Protocol = NginxStreamProtocol.Tcp,
            ListenPort = 15432,
            Upstream = new NginxEndpointUpstream("db.nowhere.example:5432"),
        };

        var outcome = await kit.ApplyAsync(new NginxConfiguration(
            [Site() with { ServerSnippet = "location /api/ {\n    proxy_pass http://metadata.nowhere.example/;\n}\n" }],
            [stream]));

        Assert.Equal(["sites[app].serverSnippet", "streams[db].upstream"], outcome.Problems.Select(p => p.Field));
        Assert.All(outcome.Problems, p => Assert.Contains("does not resolve", p.Message, StringComparison.Ordinal));
    }

    [Fact]
    public async Task Certificate_files_are_root_only()
    {
        using var kit = await ReadyAsync();
        var site = Site() with { Certificate = new NginxCertificate(kit.Layout.CertificateFile("app"), kit.Layout.KeyFile("app")) };

        var outcome = await kit.ApplyAsync(Config(site), new NginxCertificateFiles("app", "CHAIN", "KEY"));

        Assert.True(outcome.Applied);
        Assert.Equal("KEY", kit.Machine.Text(kit.Layout.KeyFile("app")));
        Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, kit.Machine.ModeOf(kit.Layout.KeyFile("app")));
        Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute, kit.Machine.ModeOf(kit.Layout.CertificatesDirectory + "/app"));

        // Without a certificate the files go with the next apply.
        await kit.ApplyAsync(Config(Site()));
        Assert.False(kit.Machine.Exists(kit.Layout.CertificatesDirectory + "/app"));
    }

    [Fact]
    public async Task Old_releases_are_pruned_and_the_newest_kept()
    {
        using var kit = await ReadyAsync();
        for (var i = 0; i < NginxApplier.KeptReleases + 3; i++)
        {
            Assert.True((await kit.ApplyAsync(Config(Site(domain: $"app{i}.example.com")))).Applied);
        }

        var releases = await kit.Machine.ListAsync(kit.Layout.ReleasesDirectory, Cancel);
        Assert.Equal(NginxApplier.KeptReleases + 1, releases.Count);
        Assert.Contains("9", releases);
    }

    [Fact]
    public async Task Stream_proxies_are_refused_when_this_nginx_cannot_load_them()
    {
        using var kit = new NginxKit();
        kit.Machine.TestFailure = machine => machine.Text("/etc/nginx/nginx.conf")!.Contains("stream {", StringComparison.Ordinal) ? "nginx: [emerg] unknown directive \"stream\"" : null;
        await kit.SetUpAsync();
        var stream = new NginxStreamProxy { Id = "dns", Protocol = NginxStreamProtocol.Udp, ListenPort = 5353, Upstream = new NginxServiceUpstream("dns", 53) };

        var outcome = await kit.ApplyAsync(new NginxConfiguration([], [stream]));

        Assert.Equal("streams", Assert.Single(outcome.Problems).Field);
    }

    [Fact]
    public async Task With_selinux_on_a_stream_proxys_port_gets_the_http_port_label()
    {
        using var kit = await ReadyAsync();
        kit.Machine.SeLinux = true;
        kit.Machine.Intercept = spec => spec.Arguments is ["port", "-a", ..]
            ? new Execution.ProcessResult(1, string.Empty, "ValueError: Port tcp/15432 already defined", false, false)
            : null;
        var stream = new NginxStreamProxy { Id = "db", Protocol = NginxStreamProtocol.Tcp, ListenPort = 15432, Upstream = new NginxServiceUpstream("db", 5432) };

        var outcome = await kit.ApplyAsync(new NginxConfiguration([], [stream]));

        Assert.True(outcome.Applied);
        Assert.Contains("semanage port -m -t http_port_t -p tcp 15432", kit.Machine.Commands);
        Assert.Empty(outcome.Warnings);
    }

    [Fact]
    public async Task On_start_an_apply_interrupted_before_the_reload_is_undone()
    {
        using var kit = await ReadyAsync();
        await kit.Machine.CreateDirectoryAsync(kit.Layout.ReleaseDirectory(2), UnixFileMode.UserRead, Cancel);
        kit.Machine.WriteText(kit.Layout.ReleaseDirectory(2) + "/http.conf", "broken");
        await kit.Machine.ReplaceLinkAsync(kit.Layout.CurrentLink, "releases/2", Cancel);
        WriteMarker(kit, new NginxApplyMarker(2, 1, NginxApplyMarker.Switched, NginxKit.Plan(Config()).State, 0));

        var recovered = await kit.Applier.RecoverAsync(kit.Layout, await kit.InspectAsync(), Cancel);

        Assert.Equal(NginxApplyMarker.Switched, recovered!.Phase);
        Assert.Equal("releases/1", await kit.Machine.ReadLinkAsync(kit.Layout.CurrentLink, Cancel));
        Assert.False(kit.Machine.Exists(kit.Layout.ReleaseDirectory(2)));
        Assert.False(kit.Machine.Exists(kit.Layout.ApplyMarker));
        Assert.Equal(2, kit.Machine.Reloads);
    }

    [Fact]
    public async Task On_start_an_apply_nginx_already_runs_is_handed_back_to_be_recorded()
    {
        using var kit = await ReadyAsync();
        var state = new NginxAppliedState("abc", new Dictionary<string, string> { ["app"] = "f1" }, new Dictionary<string, string>());
        WriteMarker(kit, new NginxApplyMarker(1, null, NginxApplyMarker.Reloaded, state, 0));

        var recovered = await kit.Applier.RecoverAsync(kit.Layout, await kit.InspectAsync(), Cancel);

        Assert.Equal(("abc", "f1"), (recovered!.State.Hash, recovered.State.Sites["app"]));
        Assert.Equal("releases/1", await kit.Machine.ReadLinkAsync(kit.Layout.CurrentLink, Cancel));
        Assert.True(kit.Machine.Exists(kit.Layout.ApplyMarker));
        using var clean = await ReadyAsync();
        Assert.Null(await clean.Applier.RecoverAsync(clean.Layout, await clean.InspectAsync(), Cancel));
    }

    private static void WriteMarker(NginxKit kit, NginxApplyMarker marker) =>
        kit.Machine.WriteText(kit.Layout.ApplyMarker, JsonSerializer.Serialize(marker, CoreJson.Options));
}
