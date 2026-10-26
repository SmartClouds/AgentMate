using Runova.ServerCore.Cloudflare;

namespace Runova.ServerCore.Tests.Cloudflare;

/// <summary>A list of ranges is only taken whole: every entry a canonical, public network of its family.</summary>
public sealed class CloudflareRangeListTests
{
    [Fact]
    public void The_published_list_parses_sorted_and_canonical()
    {
        var ranges = CloudflareRangeList.Parse(CloudflareRecordings.Ipv4, CloudflareRecordings.Ipv6, 42);

        Assert.Equal(15, ranges.Ipv4.Length);
        Assert.Equal(7, ranges.Ipv6.Length);
        Assert.Equal(ranges.Ipv4.Order(StringComparer.Ordinal), ranges.Ipv4);
        Assert.Equal(42, ranges.FetchedAtUnixMs);
    }

    [Theory]
    [InlineData("10.0.0.0/8")]
    [InlineData("192.168.0.0/16")]
    [InlineData("127.0.0.0/8")]
    [InlineData("100.64.0.0/10")]
    [InlineData("0.0.0.0/0")]
    [InlineData("8.0.0.0/4")]
    [InlineData("173.245.48.1/20")]
    [InlineData("173.245.48.7")]
    [InlineData("2400:cb00::/32")]
    [InlineData("173.245.48.0/20\nset_real_ip_from 0.0.0.0/0")]
    public void A_list_with_one_bad_ipv4_entry_is_refused_whole(string bad)
    {
        Assert.Throws<CloudflareApiException>(() => CloudflareRangeList.Parse(["173.245.48.0/20", bad], ["2400:cb00::/32"], 0));
    }

    [Theory]
    [InlineData("fd00::/8")]
    [InlineData("fe80::/10")]
    [InlineData("::/0")]
    [InlineData("2000::/3")]
    [InlineData("173.245.48.0/20")]
    public void A_list_with_one_bad_ipv6_entry_is_refused_whole(string bad)
    {
        Assert.Throws<CloudflareApiException>(() => CloudflareRangeList.Parse(["173.245.48.0/20"], ["2400:cb00::/32", bad], 0));
    }

    [Fact]
    public void A_family_missing_or_too_many_ranges_is_refused()
    {
        Assert.Throws<CloudflareApiException>(() => CloudflareRangeList.Parse([], ["2400:cb00::/32"], 0));
        Assert.Throws<CloudflareApiException>(() => CloudflareRangeList.Parse(["173.245.48.0/20"], [], 0));
        var many = Enumerable.Range(0, 101).Select(i => $"45.{i}.0.0/16").ToArray();
        Assert.Throws<CloudflareApiException>(() => CloudflareRangeList.Parse(many, ["2400:cb00::/32"], 0));
    }
}
