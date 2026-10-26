using System.Net;
using Runova.ServerCore.Hosting;
using Runova.ServerCore.Nginx;

namespace Runova.ServerCore.Tests.Nginx;

/// <summary>
/// A site's upstream decides where nginx connects on behalf of anyone on the internet. Targets that
/// would hand visitors the cloud's metadata service (and with it the server's credentials), the
/// core itself or the Docker API are refused, whichever way the address is written.
/// </summary>
public sealed class UpstreamPolicyTests
{
    private static readonly UpstreamPolicy _policy = UpstreamPolicy.Default;

    private static string Accepted(string text)
    {
        Assert.True(_policy.TryParseUrl(text, out var url, out var problem), problem);
        return url.ToNginx();
    }

    private static string Refused(string text)
    {
        Assert.False(_policy.TryParseUrl(text, out _, out var problem), $"'{text}' was accepted");
        return problem;
    }

    [Theory]
    [InlineData("http://127.0.0.1:3000", "http://127.0.0.1:3000")]
    [InlineData("HTTP://Backend.Internal:8080/app/", "http://backend.internal:8080/app/")]
    [InlineData("https://api.example.com", "https://api.example.com")]
    [InlineData("http://[::1]:8080/", "http://[::1]:8080/")]
    [InlineData("http://[2001:DB8::0:1]/x", "http://[2001:db8::1]/x")]
    [InlineData("http://10.0.0.5", "http://10.0.0.5")]
    [InlineData("http://localhost:3000", "http://localhost:3000")]
    [InlineData("https://example.com/a/b%20c/", "https://example.com/a/b%20c/")]
    [InlineData("http://example.com.:81", "http://example.com:81")]
    public void Ordinary_upstreams_render_in_their_canonical_form(string text, string rendered)
    {
        Assert.Equal(rendered, Accepted(text));
    }

    [Theory]
    [InlineData("http://169.254.169.254/latest/meta-data/", "metadata")]
    [InlineData("http://169.254.0.1", "link-local")]
    [InlineData("http://[fe80::1]", "link-local")]
    [InlineData("http://[::ffff:169.254.169.254]", "metadata")]
    [InlineData("http://[::ffff:a9fe:a9fe]", "metadata")]
    [InlineData("http://[64:ff9b::a9fe:a9fe]", "metadata")]
    [InlineData("http://[2002:a9fe:a9fe::1]", "metadata")]
    [InlineData("http://[fd00:ec2::254]", "metadata")]
    [InlineData("http://100.100.100.200", "metadata")]
    [InlineData("http://168.63.129.16", "Azure")]
    [InlineData("http://0.0.0.0:3000", "0.0.0.0")]
    [InlineData("http://[::]:3000", "unspecified")]
    [InlineData("http://224.0.0.1", "multicast")]
    [InlineData("http://[ff02::1]", "multicast")]
    [InlineData("http://255.255.255.255", "broadcast")]
    [InlineData("http://metadata.google.internal/computeMetadata/v1/", "metadata")]
    [InlineData("http://metadata", "metadata")]
    [InlineData("http://METADATA.GOOGLE.INTERNAL./", "metadata")]
    [InlineData("http://instance-data.ec2.internal", "metadata")]
    public void Metadata_link_local_and_non_addresses_are_refused(string text, string reason)
    {
        Assert.Contains(reason, Refused(text), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("http://2852039166")]
    [InlineData("http://0xa9fea9fe")]
    [InlineData("http://0251.0376.0251.0376")]
    [InlineData("http://169.254.43518")]
    [InlineData("http://010.0.0.1")]
    [InlineData("http://127.1")]
    [InlineData("http://0x7f.1")]
    public void Numeric_shorthands_the_system_resolver_would_turn_into_addresses_are_refused(string text)
    {
        Assert.Contains("numeric", Refused(text), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("http://127.0.0.1:7810", "core")]
    [InlineData("http://localhost:2375", "Docker")]
    [InlineData("https://10.0.0.9:2376", "Docker")]
    [InlineData("http://unix:/run/runova-core/core.sock:/", "Unix socket")]
    [InlineData("http://unix:/var/run/docker.sock:/containers/json", "Unix socket")]
    [InlineData("http://$host", "variable")]
    [InlineData("http://example.com/$request_uri", "variable")]
    public void The_core_the_docker_api_sockets_and_variables_are_refused(string text, string reason)
    {
        Assert.Contains(reason, Refused(text), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("http://user:pass@example.com", "user")]
    [InlineData("http://example.com/?a=1", "query")]
    [InlineData("http://example.com/#x", "#")]
    [InlineData("ftp://example.com", "http:// or https://")]
    [InlineData("example.com:3000", "http:// or https://")]
    [InlineData("http://exa mple.com", "space")]
    [InlineData("http://example.com;include", "character")]
    [InlineData("http://example.com/a\"b", "character")]
    [InlineData("http://example.com/{x}", "character")]
    [InlineData("http://example.com:0", "port")]
    [InlineData("http://example.com:65536", "port")]
    [InlineData("http://example.com:080", "port")]
    [InlineData("http://example.com:", "port")]
    [InlineData("http://-bad.example.com", "host name")]
    [InlineData("http://ex_ample.com", "host name")]
    [InlineData("http://exämple.com", "character")]
    [InlineData("http://[fe80::1%25eth0]", "zone")]
    [InlineData("http://example.com/a/../b", "path")]
    [InlineData("http://example.com/%zz", "percent")]
    [InlineData("http://", "host")]
    [InlineData("", "http:// or https://")]
    public void Malformed_urls_are_refused_with_a_reason(string text, string reason)
    {
        Assert.Contains(reason, Refused(text), StringComparison.Ordinal);
    }

    [Fact]
    public void The_core_port_from_its_listen_options_is_refused_too()
    {
        var policy = UpstreamPolicy.For(new CoreListenOptions(null, 9443));

        Assert.False(policy.TryParseUrl("http://127.0.0.1:9443", out _, out var problem));
        Assert.Contains("core", problem, StringComparison.Ordinal);
        Assert.NotNull(policy.CheckPort(7810));
    }

    [Theory]
    [InlineData("169.254.169.254")]
    [InlineData("fe80::abcd")]
    [InlineData("::ffff:169.254.1.1")]
    [InlineData("fd00:ec2::254")]
    [InlineData("0.0.0.0")]
    [InlineData("::")]
    public void Resolved_addresses_can_be_checked_on_their_own(string address)
    {
        Assert.NotNull(UpstreamPolicy.CheckAddress(IPAddress.Parse(address)));
    }

    [Theory]
    [InlineData("127.0.0.1")]
    [InlineData("::1")]
    [InlineData("10.1.2.3")]
    [InlineData("192.168.1.10")]
    [InlineData("100.64.0.1")]
    [InlineData("203.0.113.9")]
    [InlineData("2001:db8::10")]
    public void Ordinary_addresses_pass(string address)
    {
        Assert.Null(UpstreamPolicy.CheckAddress(IPAddress.Parse(address)));
    }

    [Fact]
    public void Every_link_local_address_is_refused_however_it_is_written()
    {
        var random = new Random(1045);
        for (var i = 0; i < 500; i++)
        {
            var v4 = new IPAddress([169, 254, (byte)random.Next(256), (byte)random.Next(256)]);
            Assert.NotNull(UpstreamPolicy.CheckAddress(v4));
            Assert.NotNull(UpstreamPolicy.CheckAddress(v4.MapToIPv6()));
            Assert.False(_policy.TryParseUrl($"http://{v4}/", out _, out _));
            Assert.False(_policy.TryParseUrl($"http://[{v4.MapToIPv6()}]/", out _, out _));

            var v6 = new byte[16];
            random.NextBytes(v6);
            v6[0] = 0xfe;
            v6[1] = (byte)(0x80 | (v6[1] & 0x3f));
            Assert.False(_policy.TryParseUrl($"http://[{new IPAddress(v6)}]/", out _, out _));
        }
    }

    [Fact]
    public void Whatever_is_accepted_renders_as_one_plain_nginx_word_and_parses_back_to_itself()
    {
        const string alphabet = "abcxyz019.-:/[]%@?#$;{}'\"\\ \t\r\nAZ_~!&()*+,=";
        var random = new Random(20261001);
        var accepted = 0;
        for (var i = 0; i < 20_000; i++)
        {
            var length = random.Next(1, 24);
            var chars = new char[length];
            for (var c = 0; c < length; c++)
            {
                chars[c] = alphabet[random.Next(alphabet.Length)];
            }

            var text = (random.Next(2) == 0 ? "http://" : "https://") + new string(chars);
            if (!_policy.TryParseUrl(text, out var url, out _))
            {
                continue;
            }

            accepted++;
            var rendered = url.ToNginx();
            Assert.DoesNotMatch("[\\s;{}'\"\\\\$#]", rendered);
            var directive = Assert.Single(NginxConfigParser.Parse($"proxy_pass {rendered};"));
            Assert.Equal([rendered], directive.Arguments);
            Assert.True(_policy.TryParseUrl(rendered, out var again, out _));
            Assert.Equal(rendered, again.ToNginx());
        }

        Assert.True(accepted > 100, $"Only {accepted} random URLs were valid, too few to mean anything.");
    }

    [Theory]
    [InlineData("127.0.0.1:5432", "127.0.0.1:5432")]
    [InlineData("db.internal:5432", "db.internal:5432")]
    [InlineData("[::1]:53", "[::1]:53")]
    public void Stream_endpoints_are_a_host_and_a_port(string text, string rendered)
    {
        Assert.True(_policy.TryParseEndpoint(text, out var endpoint, out var problem), problem);
        Assert.Equal(rendered, endpoint.ToNginx());
    }

    [Theory]
    [InlineData("127.0.0.1", "port")]
    [InlineData("169.254.169.254:80", "metadata")]
    [InlineData("127.0.0.1:7810", "core")]
    [InlineData("unix:/run/runova-core/core.sock", "Unix socket")]
    [InlineData("http://127.0.0.1:80", "host")]
    public void Stream_endpoints_follow_the_same_rules(string text, string reason)
    {
        Assert.False(_policy.TryParseEndpoint(text, out _, out var problem));
        Assert.Contains(reason, problem, StringComparison.Ordinal);
    }
}
