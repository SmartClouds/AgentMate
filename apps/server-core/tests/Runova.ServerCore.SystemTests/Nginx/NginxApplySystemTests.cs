using Microsoft.Extensions.Logging.Abstractions;
using Runova.ServerCore.Nginx;
using Runova.ServerCore.Tests.Nginx;

namespace Runova.ServerCore.SystemTests.Nginx;

public sealed class DebianNginxApplyTests(DebianNginxFixture fixture) : NginxApplySystemTests(fixture), IClassFixture<DebianNginxFixture>;

public sealed class RockyNginxApplyTests(RockyNginxFixture fixture) : NginxApplySystemTests(fixture), IClassFixture<RockyNginxFixture>;

/// <summary>
/// E10 T5 and AC2 against real nginx.org nginx: the core's own apply code (over docker exec)
/// puts a release live and confirms it by new workers, keeps the running release when nginx -t
/// or the reload refuses the new one, and undoes an apply a crashed core left halfway.
/// </summary>
public abstract class NginxApplySystemTests(NginxHarnessFixture fixture)
{
    private const string Domain = "core.test";

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    internal sealed record Core(NginxHarness Harness, DockerNginxMachine Machine, NginxControl Control, NginxApplier Applier)
    {
        public NginxLayout Layout => Harness.Layout;

        public async Task<NginxApplyOutcome> ApplyAsync(NginxConfiguration configuration, params NginxCertificateFiles[] certificates)
        {
            using var lease = await Applier.LockAsync(Cancel);
            var plan = new NginxApplyPlan(configuration, certificates, new NginxAppliedState("system-test", new Dictionary<string, string>(), new Dictionary<string, string>()));
            var outcome = await Applier.ApplyAsync(plan, await Control.InspectAsync(Layout, Cancel), Layout, Cancel);
            if (outcome.Applied)
            {
                await Applier.CompleteAsync(plan, Layout, outcome.Release!.Value, Cancel);
            }

            return outcome;
        }
    }

    internal static Core Connect(NginxHarness harness)
    {
        var machine = new DockerNginxMachine(harness.Nginx);
        var control = new NginxControl(machine, TimeProvider.System);
        var applier = new NginxApplier(control, new NginxSeLinux(machine), new DnsUpstreamResolver(), UpstreamPolicy.Default, TimeProvider.System, NullLogger<NginxApplier>.Instance);
        return new Core(harness, machine, control, applier);
    }

    internal static NginxSite Site(string id = "core-app", string domain = Domain) => new()
    {
        Id = id,
        Domains = [domain],
        Upstream = new NginxServiceUpstream("app", NginxVariants.UpstreamPort),
        BasicAuth = new NginxBasicAuth([new NginxBasicAuthUser(NginxVariants.User, NginxVariants.PasswordHash)]),
    };

    private static string[] Http(string path = "/") => ["--resolve", $"{Domain}:80:127.0.0.1", $"http://{Domain}{path}"];

    private async Task<Core> StartAsync()
    {
        DockerCli.RequireAvailable();
        var core = Connect(await fixture.GetAsync());
        var applied = await core.ApplyAsync(new NginxConfiguration([Site()], []));
        Assert.True(applied.Applied, string.Join("\n", applied.Problems));
        return core;
    }

    [Fact]
    public async Task A_release_the_core_applies_serves_with_basic_auth_and_logs_per_site()
    {
        var core = await StartAsync();
        var nginx = core.Harness;

        Assert.Equal(401, (await nginx.CurlAsync(Cancel, Http())).Status);
        var signedIn = await nginx.CurlAsync(Cancel, ["-u", $"{NginxVariants.User}:{NginxVariants.Password}", .. Http("/logged")]);
        Assert.Equal(200, signedIn.Status);
        Assert.Contains("upstream: http", signedIn.Body, StringComparison.Ordinal);
        Assert.Equal(200, (await nginx.CurlAsync(Cancel, Http("/.well-known/acme-challenge/" + NginxHarness.AcmeToken))).Status);
        var log = await core.Machine.ReadTextAsync(core.Layout.AccessLog("core-app"), Cancel);
        Assert.Contains("GET /logged HTTP/1.1", log, StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_snippet_nginx_refuses_keeps_the_running_release_and_names_the_line()
    {
        var core = await StartAsync();
        var before = await core.Machine.ReadLinkAsync(core.Layout.CurrentLink, Cancel);

        var outcome = await core.ApplyAsync(new NginxConfiguration([Site() with { LocationSnippet = "gzip on;\nexpires sometimes;\n" }], []));

        Assert.False(outcome.Applied);
        var problem = Assert.Single(outcome.Problems);
        Assert.Equal(("sites[core-app].locationSnippet", 2), (problem.Field, problem.Line));
        Assert.Contains("expires", problem.Message, StringComparison.Ordinal);
        Assert.Equal(before, await core.Machine.ReadLinkAsync(core.Layout.CurrentLink, Cancel));
        Assert.Equal(401, (await core.Harness.CurlAsync(Cancel, Http())).Status);
    }

    [Fact]
    public async Task A_port_in_use_passes_nginx_t_but_not_the_reload_is_rolled_back_and_leaves_nothing_for_the_next_apply()
    {
        var core = await StartAsync();
        var before = await core.Machine.ReadLinkAsync(core.Layout.CurrentLink, Cancel);
        var taken = new NginxStreamProxy
        {
            Id = "taken",
            Protocol = NginxStreamProtocol.Tcp,
            ListenPort = NginxVariants.UpstreamPort,
            Upstream = new NginxServiceUpstream("app", NginxVariants.UpstreamPort),
        };

        var outcome = await core.ApplyAsync(new NginxConfiguration([Site()], [taken]));

        Assert.False(outcome.Applied);
        Assert.Contains(outcome.Problems, p => p.Message.Contains("Address already in use", StringComparison.Ordinal));
        Assert.Equal(before, await core.Machine.ReadLinkAsync(core.Layout.CurrentLink, Cancel));
        Assert.True((await core.Harness.TestConfigurationAsync(Cancel)).Succeeded);
        Assert.Equal(401, (await core.Harness.CurlAsync(Cancel, Http())).Status);

        // The refusal was over when the apply returned: nginx's last tries at the port do not
        // reach the next apply as its cause (nightly run 37097759993).
        var next = await core.ApplyAsync(new NginxConfiguration([Site()], []));
        Assert.True(next.Applied, string.Join("\n", next.Problems));
    }

    [Fact]
    public async Task An_apply_a_crashed_core_left_halfway_is_undone_on_start()
    {
        var core = await StartAsync();
        var before = NginxControl.ReleaseOf(await core.Machine.ReadLinkAsync(core.Layout.CurrentLink, Cancel))!.Value;
        var broken = before + 1;
        await core.Machine.WriteAsync($"{core.Layout.ReleaseDirectory(broken)}/http.conf", "this is not nginx;"u8.ToArray(), UnixFileMode.UserRead | UnixFileMode.UserWrite, Cancel);
        await core.Machine.WriteAsync($"{core.Layout.ReleaseDirectory(broken)}/stream.conf", ""u8.ToArray(), UnixFileMode.UserRead | UnixFileMode.UserWrite, Cancel);
        await core.Machine.ReplaceLinkAsync(core.Layout.CurrentLink, $"releases/{broken}", Cancel);
        var marker = new NginxApplyMarker(broken, before, NginxApplyMarker.Switched, new NginxAppliedState("x", new Dictionary<string, string>(), new Dictionary<string, string>()), 0);
        await core.Machine.WriteAsync(core.Layout.ApplyMarker, System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(marker, CoreJson.Options), UnixFileMode.UserRead | UnixFileMode.UserWrite, Cancel);

        var recovered = await core.Applier.RecoverAsync(core.Layout, await core.Control.InspectAsync(core.Layout, Cancel), Cancel);

        Assert.Equal(broken, recovered!.Release);
        Assert.Equal($"releases/{before}", await core.Machine.ReadLinkAsync(core.Layout.CurrentLink, Cancel));
        Assert.False(await core.Machine.ExistsAsync(core.Layout.ReleaseDirectory(broken), Cancel));
        Assert.False(await core.Machine.ExistsAsync(core.Layout.ApplyMarker, Cancel));
        Assert.True((await core.Harness.TestConfigurationAsync(Cancel)).Succeeded);
    }
}
