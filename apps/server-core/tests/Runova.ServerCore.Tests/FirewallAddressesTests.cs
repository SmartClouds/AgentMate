using System.Net;
using Runova.ServerCore.Firewall;

namespace Runova.ServerCore.Tests;

/// <summary>
/// Sources in rules come from a person typing them, so they are read strictly and written back in
/// one canonical form: the form ufw and firewalld show, which is also what a rule's id is made of.
/// </summary>
public sealed class FirewallAddressesTests
{
    [Theory]
    [InlineData("203.0.113.7", "203.0.113.7")]
    [InlineData("10.0.0.0/8", "10.0.0.0/8")]
    [InlineData(" 192.168.1.0/24 ", "192.168.1.0/24")]
    [InlineData("10.0.0.5/32", "10.0.0.5")]
    [InlineData("0.0.0.0/0", "0.0.0.0/0")]
    [InlineData("2001:db8::/32", "2001:db8::/32")]
    [InlineData("2001:DB8:0:0::1", "2001:db8::1")]
    [InlineData("2001:db8::1/128", "2001:db8::1")]
    [InlineData("::/0", "::/0")]
    public void A_source_is_read_into_its_canonical_form(string text, string canonical)
    {
        Assert.True(FirewallAddresses.TryParseNetwork(text, out var network, out var error), error);
        Assert.Equal(canonical, FirewallAddresses.Format(network));
    }

    [Theory]
    [InlineData("10.0.0.5/8", "did you mean 10.0.0.0/8")]
    [InlineData("2001:db8::1/32", "did you mean 2001:db8::/32")]
    [InlineData("127.1", "not an IP address")]
    [InlineData("0x7f.0.0.1", "not an IP address")]
    [InlineData("10.0.0.256", "not an IP address")]
    [InlineData("example.com", "not an IP address")]
    [InlineData("10.0.0.0/33", "prefix")]
    [InlineData("2001:db8::/129", "prefix")]
    [InlineData("10.0.0.0/08", "prefix")]
    [InlineData("10.0.0.0/", "prefix")]
    [InlineData("fe80::1%eth0", "zone")]
    [InlineData("::ffff:10.0.0.1", "as 10.0.0.1")]
    [InlineData("10.0.0.0/8; reboot", "not an IP address")]
    [InlineData("", "empty")]
    [InlineData("   ", "empty")]
    public void A_bad_source_is_refused_with_a_reason(string text, string reason)
    {
        Assert.False(FirewallAddresses.TryParseNetwork(text, out _, out var error));
        Assert.Contains(reason, error, StringComparison.Ordinal);
    }

    [Fact]
    public void Addresses_from_the_kernel_and_sshd_are_normalized()
    {
        Assert.Equal(IPAddress.Parse("10.0.0.1"), FirewallAddresses.Normalize(IPAddress.Parse("::ffff:10.0.0.1")));
        Assert.Equal("fe80::1", FirewallAddresses.Normalize(IPAddress.Parse("fe80::1%3")).ToString());
        Assert.True(FirewallAddresses.TryParseAddress("203.0.113.9", out var plain));
        Assert.Equal(IPAddress.Parse("203.0.113.9"), plain);
        Assert.False(FirewallAddresses.TryParseAddress("203.0.113.0/24", out _));
        Assert.False(FirewallAddresses.TryParseAddress("127.1", out _));
    }
}
