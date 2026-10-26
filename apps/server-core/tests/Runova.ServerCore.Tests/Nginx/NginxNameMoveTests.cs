using System.Text;
using Microsoft.Extensions.Logging.Abstractions;
using Runova.ServerCore.Compatibility;
using Runova.ServerCore.Contracts;
using Runova.ServerCore.Nginx;
using Runova.ServerCore.Platform;
using Runova.ServerCore.Web;

namespace Runova.ServerCore.Tests.Nginx;

/// <summary>
/// Moving nginx on a server set up before the rename to the new names: nginx.conf rewired without
/// ever loading a file twice, every site rendered again with the new folders and names, snippet
/// roots and log files following, and everything put back when nginx does not take it.
/// </summary>
public sealed class NginxNameMoveTests
{
    private const string Journal = "/var/lib/runova-core/nginx-move.json";

    private static readonly NginxLayout _old = NginxLayout.Debian.WithLegacyNames();
    private static readonly NginxLayout _new = NginxLayout.Debian;

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private static NginxSite Site(NginxLayout layout, string? serverSnippet = null) => new()
    {
        Id = "blog",
        Domains = ["blog.example.com"],
        Upstream = new NginxServiceUpstream("web", 3000),
        Websocket = true,
        ProxyCache = new NginxProxyCache(),
        RateLimit = new NginxRateLimit(10, NginxRatePeriod.Second),
        ServerSnippet = serverSnippet ?? $"location /static/ {{\n    root {layout.SiteFolder("blog")};\n}}\n",
    };

    [Fact]
    public void Rewiring_swaps_each_include_in_place_and_keeps_everything_else()
    {
        var text = $"http {{\n    include /etc/nginx/conf.d/*.conf;\n    {_old.HttpInclude}\r\n}}\n\n{LegacyNames.NginxNote}\nstream {{\n\t{_old.StreamInclude}\n}}\n";

        var rewired = NginxConfWiring.Rewire(text, _old, _new);

        Assert.Equal(
            $"http {{\n    include /etc/nginx/conf.d/*.conf;\n    {_new.HttpInclude}\r\n}}\n\n# Added by Runova: the sites and proxies it manages.\nstream {{\n\t{_new.StreamInclude}\n}}\n",
            rewired);
        Assert.Equal((true, true), NginxConfWiring.IsWired(rewired, _new));
        Assert.Equal((false, false), NginxConfWiring.IsWired(rewired, _old));
        Assert.Equal(rewired, NginxConfWiring.Rewire(rewired, _old, _new));
    }

    [Fact]
    public void Rewiring_never_leaves_two_includes()
    {
        var text = $"http {{\n    {_new.HttpInclude}\n    {_old.HttpInclude}\n}}\n";

        var rewired = NginxConfWiring.Rewire(text, _old, _new);

        Assert.Equal($"http {{\n    {_new.HttpInclude}\n}}\n", rewired);
    }

    [Fact]
    public void Rewiring_back_restores_the_old_lines()
    {
        var wired = NginxConfWiring.Wire(SimulatedNginxMachine.StockNginxConf, _old, stream: true);

        Assert.Equal(wired, NginxConfWiring.Rewire(NginxConfWiring.Rewire(wired, _old, _new), _new, _old));
    }

    [Fact]
    public void Each_layout_renders_only_its_own_names()
    {
        var old = Render(_old);
        var renamed = Render(_new);

        foreach (var name in new[] { "_cache_blog", "_rate_blog", "_connection_upgrade", "_tls:" })
        {
            Assert.Contains(LegacyNames.NginxNamePrefix + name, old, StringComparison.Ordinal);
            Assert.Contains("runova" + name, renamed, StringComparison.Ordinal);
        }

        Assert.Contains($"/var/log/nginx/{LegacyNames.NginxNamePrefix}-blog.access.log", old, StringComparison.Ordinal);
        Assert.Contains($"/var/cache/nginx/{LegacyNames.NginxNamePrefix}-blog", old, StringComparison.Ordinal);
        Assert.Contains(LegacyNames.NginxWebRoot + "/sites/blog", old, StringComparison.Ordinal);
        Assert.DoesNotContain("runova", old, StringComparison.Ordinal);
        Assert.DoesNotContain(LegacyNames.NginxNamePrefix, renamed, StringComparison.Ordinal);

        static string Render(NginxLayout layout)
        {
            var site = Site(layout) with { Certificate = new NginxCertificate(layout.CertificateFile("blog"), layout.KeyFile("blog")) };
            var release = NginxRenderer.Render(new NginxConfiguration([site], []), layout, UpstreamPolicy.Default, release: 3);
            return string.Join("\n", release.Files.Select(file => file.Content));
        }
    }

    [Fact]
    public async Task A_server_from_before_the_rename_moves_to_the_new_names()
    {
        using var kit = await LegacyServerAsync();
        var data = new FakeMoveData();
        var original = kit.Machine.Text(SimulatedNginxMachine.NginxConf);

        var status = await Move(kit, data).RunAsync(Cancel);

        Assert.Equal(new NameMoveStatus(NameMovePhase.Done), status);
        Assert.Equal(_new.ConfigRoot, await kit.Machine.ReadLinkAsync(_old.ConfigRoot, Cancel));
        Assert.Equal(_new.WebRoot, await kit.Machine.ReadLinkAsync(_old.WebRoot, Cancel));
        Assert.Null(await kit.Machine.ReadLinkAsync(_new.ConfigRoot, Cancel));
        var conf = kit.Machine.Text(SimulatedNginxMachine.NginxConf)!;
        Assert.Equal(NginxConfWiring.Rewire(original!, _old, _new), conf);
        Assert.DoesNotContain(_old.HttpInclude, conf, StringComparison.Ordinal);
        var current = await kit.Control.CurrentReleaseAsync(_new, Cancel);
        Assert.Equal(3, current);
        var site = kit.Machine.Text($"{_new.CurrentLink}/sites/blog.conf")!;
        Assert.Contains($"root {_new.SiteFolder("blog")};", site, StringComparison.Ordinal);
        Assert.DoesNotContain(LegacyNames.NginxNamePrefix, site, StringComparison.Ordinal);
        Assert.Equal($"location /static/ {{\n    root {_new.SiteFolder("blog")};\n}}\n", data.Rows.Single().ServerSnippet);
        Assert.True(kit.Machine.Exists("/var/log/nginx/runova-blog.access.log"));
        Assert.False(kit.Machine.Exists($"/var/log/nginx/{LegacyNames.NginxNamePrefix}-blog.access.log"));
        Assert.False(kit.Machine.Exists($"/var/cache/nginx/{LegacyNames.NginxNamePrefix}-blog"));
        Assert.True(kit.Machine.Exists($"{_new.SiteFolder("blog")}/static/hello.txt"));
        Assert.False(kit.Machine.Exists(Journal));
        Assert.Equal([3], data.Recorded);
        Assert.Equal(NameMovePhase.Done, (await Move(kit, data).RunAsync(Cancel)).Phase);
    }

    [Fact]
    public async Task Anything_nginx_refuses_puts_every_old_name_back()
    {
        using var kit = await LegacyServerAsync();
        var data = new FakeMoveData();
        var original = kit.Machine.Text(SimulatedNginxMachine.NginxConf);
        kit.Machine.TestFailure = machine =>
            machine.Text($"{_new.CurrentLink}/http.conf")?.Contains("runova_connection_upgrade", StringComparison.Ordinal) == true
                ? "nginx: [emerg] the duplicate \"runova_connection_upgrade\" variable in /etc/nginx/conf.d/zz.conf:1"
                : null;

        var status = await Move(kit, data).RunAsync(Cancel);

        Assert.Equal(NameMovePhase.Failed, status.Phase);
        Assert.Contains("new names", status.Detail, StringComparison.Ordinal);
        AssertOldNames(kit, data, original);
    }

    [Fact]
    public async Task A_folder_that_will_not_move_puts_the_rest_back()
    {
        using var kit = await LegacyServerAsync();
        var data = new FakeMoveData();
        var original = kit.Machine.Text(SimulatedNginxMachine.NginxConf);
        kit.Machine.MoveFailure = path => path == _old.WebRoot ? "Device or resource busy" : null;

        var status = await Move(kit, data).RunAsync(Cancel);

        Assert.Equal(new NameMoveStatus(NameMovePhase.Failed, "Device or resource busy"), status);
        AssertOldNames(kit, data, original);
    }

    [Fact]
    public async Task A_move_a_core_left_halfway_is_put_back_and_done_again()
    {
        using var kit = await LegacyServerAsync();
        var data = new FakeMoveData();
        var original = kit.Machine.Text(SimulatedNginxMachine.NginxConf);
        var release = await kit.Control.CurrentReleaseAsync(_old, Cancel);
        await kit.Machine.MoveAsync(_old.ConfigRoot, _new.ConfigRoot, Cancel);
        await kit.Machine.ReplaceLinkAsync(_old.ConfigRoot, _new.ConfigRoot, Cancel);
        kit.Machine.WriteText(SimulatedNginxMachine.NginxConf, NginxConfWiring.Rewire(original!, _old, _new));
        kit.Machine.WriteText(Journal, System.Text.Json.JsonSerializer.Serialize(
            new NginxMoveJournal(NginxMoveJournal.Moving, SimulatedNginxMachine.NginxConf, original, release, [], []),
            CoreJson.Options));

        var status = await Move(kit, data).RunAsync(Cancel);

        Assert.Equal(NameMovePhase.Done, status.Phase);
        Assert.Equal(_new.ConfigRoot, await kit.Machine.ReadLinkAsync(_old.ConfigRoot, Cancel));
        Assert.False(kit.Machine.Exists(Journal));
    }

    [Fact]
    public async Task A_server_set_up_after_the_rename_has_nothing_to_move()
    {
        using var kit = new NginxKit();
        await kit.SetUpAsync();

        Assert.Equal(new NameMoveStatus(NameMovePhase.NotNeeded), await Move(kit, new FakeMoveData()).RunAsync(Cancel));
    }

    private static void AssertOldNames(NginxKit kit, FakeMoveData data, string? original)
    {
        Assert.Null(kit.Machine.ReadLinkAsync(_old.ConfigRoot, Cancel).Result);
        Assert.True(kit.Machine.Exists($"{_old.ConfigRoot}/releases/2/sites/blog.conf"));
        Assert.False(kit.Machine.Exists(_new.ConfigRoot));
        Assert.False(kit.Machine.Exists(_new.WebRoot));
        Assert.True(kit.Machine.Exists($"{_old.SiteFolder("blog")}/static/hello.txt"));
        Assert.Equal(original, kit.Machine.Text(SimulatedNginxMachine.NginxConf));
        Assert.Equal(2, kit.Control.CurrentReleaseAsync(_old, Cancel).Result);
        Assert.Equal(Site(_old).ServerSnippet, data.Rows.Single().ServerSnippet);
        Assert.True(kit.Machine.Exists($"/var/log/nginx/{LegacyNames.NginxNamePrefix}-blog.access.log"));
        Assert.False(kit.Machine.Exists("/var/log/nginx/runova-blog.access.log"));
        Assert.False(kit.Machine.Exists(Journal));
        Assert.Empty(data.Recorded);
    }

    private static NginxNameMove Move(NginxKit kit, FakeMoveData data) =>
        new(kit.Control, kit.Applier, kit.SeLinux, data, OsFamily.Debian, Journal, NullLogger<NginxNameMove>.Instance);

    /// <summary>nginx set up the way a core from before the rename did it, one site applied, its logs, cache and files.</summary>
    private static async Task<NginxKit> LegacyServerAsync()
    {
        var kit = new NginxKit();
        await kit.Setup.InstallAsync(_old, kit.Job.Context, Cancel);
        using (await kit.Applier.LockAsync(Cancel))
        {
            var plan = NginxKit.Plan(new NginxConfiguration([Site(_old)], []));
            var outcome = await kit.Applier.ApplyAsync(plan, await kit.Control.InspectAsync(_old, Cancel), _old, Cancel);
            Assert.True(outcome.Applied, outcome.Error ?? string.Join(", ", outcome.Problems.Select(problem => problem.Message)));
            await kit.Applier.CompleteAsync(plan, _old, outcome.Release!.Value, Cancel);
        }

        kit.Machine.WriteText($"/var/log/nginx/{LegacyNames.NginxNamePrefix}-blog.access.log", "GET /\n");
        await kit.Machine.CreateDirectoryAsync($"/var/cache/nginx/{LegacyNames.NginxNamePrefix}-blog", UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute, Cancel);
        kit.Machine.WriteText($"{_old.SiteFolder("blog")}/static/hello.txt", "hello\n");
        return kit;
    }

    /// <summary>The saved sites, as the move sees them: one site whose snippet serves files from its folder.</summary>
    private sealed class FakeMoveData : INginxMoveData
    {
        public List<SiteSnippetRow> Rows { get; } = [new("blog", Site(_old).ServerSnippet, null)];

        public List<int> Recorded { get; } = [];

        public Task<IReadOnlyList<SiteSnippetRow>> SnippetsAsync(CancellationToken cancellationToken) =>
            Task.FromResult<IReadOnlyList<SiteSnippetRow>>([.. Rows]);

        public Task SetSnippetsAsync(IReadOnlyList<SiteSnippetRow> snippets, CancellationToken cancellationToken)
        {
            foreach (var row in snippets)
            {
                Rows[Rows.FindIndex(existing => existing.SiteId == row.SiteId)] = row;
            }

            return Task.CompletedTask;
        }

        public Task<(NginxApplyPlan Plan, NginxAppliedState State)> PlanAsync(NginxLayout layout, CancellationToken cancellationToken)
        {
            var plan = NginxKit.Plan(new NginxConfiguration([Site(layout, Rows.Single().ServerSnippet)], []));
            return Task.FromResult((plan, plan.State));
        }

        public Task RecordAsync(int release, NginxAppliedState state, CancellationToken cancellationToken)
        {
            Recorded.Add(release);
            return Task.CompletedTask;
        }
    }
}
