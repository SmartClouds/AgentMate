using Runova.ServerCore.Contracts;
using Runova.ServerCore.Nginx;
using Runova.ServerCore.Web;

namespace Runova.ServerCore.Tests.Web;

/// <summary>E10 T8: a site's log, its last lines and then what nginx writes next, across rotation.</summary>
public sealed class SiteLogsTests
{
    private const string Path = "/var/log/nginx/runova-blog.access.log";

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    [Fact]
    public async Task New_lines_follow_the_tail_and_a_rotated_file_starts_over()
    {
        var machine = new SimulatedNginxMachine();
        machine.WriteText(Path, "one\ntwo\nthree\n");
        var logs = new SiteLogs(machine, TimeProvider.System) { PollInterval = TimeSpan.FromMilliseconds(10) };
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(Cancel);
        stop.CancelAfter(TimeSpan.FromSeconds(20));
        await using var stream = logs.StreamAsync(Path, tailLines: 2, follow: true, stop.Token).GetAsyncEnumerator(stop.Token);

        Assert.True(await stream.MoveNextAsync());
        Assert.Equal(["two", "three"], stream.Current.Lines);

        machine.AppendText(Path, "four\nhalf");
        Assert.True(await stream.MoveNextAsync());
        Assert.Equal(["four"], stream.Current.Lines);

        machine.AppendText(Path, " done\n");
        Assert.True(await stream.MoveNextAsync());
        Assert.Equal(["half done"], stream.Current.Lines);

        machine.WriteText(Path, "fresh\n");
        Assert.True(await stream.MoveNextAsync());
        Assert.True(stream.Current.Reset);
        Assert.Equal(["fresh"], stream.Current.Lines);
    }

    [Fact]
    public async Task Long_lines_are_clipped_and_control_characters_made_visible()
    {
        var machine = new SimulatedNginxMachine();
        machine.WriteText(Path, new string('x', SiteLogs.MaxLineLength + 50) + "\nbell\u0007here\r\n");
        var logs = new SiteLogs(machine, TimeProvider.System);

        var lines = new List<string>();
        await foreach (var batch in logs.StreamAsync(Path, tailLines: null, follow: false, Cancel))
        {
            lines.AddRange(batch.Lines);
        }

        Assert.Equal(SiteLogs.MaxLineLength + 1, lines[0].Length);
        Assert.Equal("bell�here", lines[1]);
        Assert.Equal("/var/log/nginx/runova-blog.error.log", SiteLogs.PathOf(NginxLayout.Debian, "blog", SiteLogKind.Error));
    }
}
