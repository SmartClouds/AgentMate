using Runova.ServerCore.Nginx;

namespace Runova.ServerCore.Tests.Nginx;

/// <summary>nginx's complaints point at files of a release; they come back pointing at what the person wrote.</summary>
public sealed class NginxTestOutputTests
{
    private static readonly NginxLayout _layout = NginxLayout.Debian;

    private static NginxRelease Release() => NginxRenderer.Render(
        NginxVariants.Get("snippets") with { Streams = NginxVariants.Get("stream-tcp").Streams },
        _layout,
        UpstreamPolicy.Default,
        release: 7);

    [Fact]
    public void An_error_in_a_snippet_file_points_at_the_snippet_line()
    {
        var stderr =
            "nginx: [emerg] unknown directive \"bogus\" in /etc/nginx/runova/releases/7/snippets/snippets.server.conf:3\n"
            + "nginx: configuration file /etc/nginx/nginx.conf test failed\n";

        var problem = Assert.Single(NginxTestOutput.Problems(stderr, Release(), _layout));

        Assert.Equal(("sites[snippets].serverSnippet", 3, "unknown directive \"bogus\""), (problem.Field, problem.Line, problem.Message));
        Assert.Equal("snippets", NginxTestOutput.SiteIdOf(problem.Field));
    }

    [Fact]
    public void An_error_in_a_generated_file_names_the_site_or_proxy_it_belongs_to()
    {
        var release = Release();
        var stream = release.Files.Single(f => f.Path == NginxRenderer.StreamFile).Content.Split('\n');
        var listen = Array.FindIndex(stream, line => line.TrimStart().StartsWith("listen", StringComparison.Ordinal)) + 1;
        var stderr =
            "nginx: [emerg] host not found in upstream \"db.internal\" in /etc/nginx/runova/releases/7/sites/snippets.conf:12\n"
            + $"nginx: [emerg] invalid port in \"x\" of the \"listen\" directive in /etc/nginx/runova/current/stream.conf:{listen}\n";

        var problems = NginxTestOutput.Problems(stderr, release, _layout);

        Assert.Equal(["sites[snippets]", $"streams[{NginxVariants.Get("stream-tcp").Streams[0].Id}]"], problems.Select(p => p.Field));
        Assert.All(problems, p => Assert.Null(p.Line));
        Assert.StartsWith("host not found in upstream", problems[0].Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Errors_outside_the_release_and_reload_errors_from_error_log_are_kept_as_they_are()
    {
        var stderr = "nginx: [emerg] open() \"/etc/nginx/mime.types\" failed (2: No such file or directory) in /etc/nginx/nginx.conf:14\n";
        var log =
            "2026/10/01 12:00:00 [notice] 1#1: signal process started\n"
            + "2026/10/01 12:00:00 [emerg] 1#1: bind() to 0.0.0.0:8443 failed (98: Address already in use)\n"
            + "2026/10/01 12:00:00 [warn] 1#1: conflicting server name \"_\" on 0.0.0.0:80, ignored\n";

        var outside = Assert.Single(NginxTestOutput.Problems(stderr, Release(), _layout));
        var reload = Assert.Single(NginxTestOutput.Problems(log, Release(), _layout));

        Assert.Equal(("nginx", "open() \"/etc/nginx/mime.types\" failed (2: No such file or directory) in /etc/nginx/nginx.conf:14"), (outside.Field, outside.Message));
        Assert.Equal(("nginx", "bind() to 0.0.0.0:8443 failed (98: Address already in use)"), (reload.Field, reload.Message));
    }

    [Fact]
    public void Output_without_a_recognizable_error_still_reports_something()
    {
        var problem = Assert.Single(NginxTestOutput.Problems("something odd\n", Release(), _layout));

        Assert.Equal("nginx", problem.Field);
        Assert.Contains("something odd", problem.Message, StringComparison.Ordinal);
    }
}
