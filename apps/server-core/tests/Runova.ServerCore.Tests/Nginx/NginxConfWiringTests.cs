using Runova.ServerCore.Nginx;

namespace Runova.ServerCore.Tests.Nginx;

/// <summary>Runova's two include lines go into nginx.conf once, wherever the stock file has its blocks.</summary>
public sealed class NginxConfWiringTests
{
    private const string NginxOrg = """
        user  nginx;
        worker_processes  auto;

        error_log  /var/log/nginx/error.log notice;
        pid        /run/nginx.pid;

        events {
            worker_connections  1024;
        }

        # http { a comment that looks like a block }
        http {
            include       /etc/nginx/mime.types;
            default_type  application/octet-stream;
            log_format  main  '$remote_addr - "$request" {braces in quotes}';

            sendfile        on;
            include /etc/nginx/conf.d/*.conf;
        }
        """;

    private static readonly NginxLayout _layout = NginxLayout.Debian;

    [Fact]
    public void The_http_include_goes_at_the_end_of_the_http_block_and_a_stream_block_is_added()
    {
        var wired = NginxConfWiring.Wire(NginxOrg, _layout, stream: true);

        var lines = wired.Split('\n');
        var include = Array.FindIndex(lines, line => line.Trim() == _layout.HttpInclude);
        Assert.True(include > Array.FindIndex(lines, line => line.Contains("conf.d/*.conf", StringComparison.Ordinal)));
        Assert.Equal("}", lines[include + 1].Trim());
        Assert.Contains($"stream {{\n    {_layout.StreamInclude}\n}}\n", wired, StringComparison.Ordinal);
        Assert.Equal((true, true), NginxConfWiring.IsWired(wired, _layout));
        Assert.Equal((false, false), NginxConfWiring.IsWired(NginxOrg, _layout));
    }

    [Fact]
    public void Wiring_twice_changes_nothing_more()
    {
        var once = NginxConfWiring.Wire(NginxOrg, _layout, stream: true);

        Assert.Equal(once, NginxConfWiring.Wire(once, _layout, stream: true));
    }

    [Fact]
    public void An_existing_stream_block_gets_the_include_inside_it()
    {
        var text = NginxOrg + "\nstream {\n    server { listen 9000; proxy_pass 127.0.0.1:9001; }\n}\n";

        var wired = NginxConfWiring.Wire(text, _layout, stream: true);

        Assert.Single(wired.Split('\n'), line => line.TrimStart().StartsWith("stream {", StringComparison.Ordinal));
        Assert.Contains($"proxy_pass 127.0.0.1:9001; }}\n    {_layout.StreamInclude}\n}}", wired, StringComparison.Ordinal);
    }

    [Fact]
    public void Without_stream_support_only_the_http_include_is_added()
    {
        var wired = NginxConfWiring.Wire(NginxOrg, _layout, stream: false);

        Assert.Equal((true, false), NginxConfWiring.IsWired(wired, _layout));
        Assert.DoesNotContain("stream {", wired, StringComparison.Ordinal);
    }

    [Fact]
    public void A_commented_out_include_does_not_count()
    {
        var text = NginxOrg.Replace("sendfile        on;", $"# {_layout.HttpInclude}", StringComparison.Ordinal);

        Assert.Equal((false, false), NginxConfWiring.IsWired(text, _layout));
        Assert.True(NginxConfWiring.IsWired(NginxConfWiring.Wire(text, _layout, stream: false), _layout).Http);
    }

    [Fact]
    public void A_file_without_an_http_block_is_refused()
    {
        var error = Assert.Throws<NginxSetupException>(() => NginxConfWiring.Wire("events { }\n", _layout, stream: true));

        Assert.Contains("http", error.Message, StringComparison.Ordinal);
    }
}
