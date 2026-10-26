using Runova.ServerCore.Certificates.Acme;

namespace Runova.ServerCore.Tests.Certificates.Acme;

/// <summary>The small parsers under the transport: Replay-Nonce values and Link headers.</summary>
public sealed class AcmeTransportTests
{
    [Theory]
    [InlineData("oFvnlFP1wIhRlYS2jTaXbA", true)]
    [InlineData("a-b_c", true)]
    [InlineData("", false)]
    [InlineData("has space", false)]
    [InlineData("padded==", false)]
    [InlineData("plus+slash/", false)]
    public void Only_base64url_nonces_are_kept(string nonce, bool valid)
    {
        var pool = new AcmeNoncePool();

        pool.Add(nonce);

        Assert.Equal(AcmeNoncePool.IsValid(nonce), valid);
        Assert.Equal(valid ? nonce : null, pool.TryTake());
    }

    [Fact]
    public void The_newest_nonce_is_used_first_and_each_only_once()
    {
        var pool = new AcmeNoncePool();
        pool.Add("first");
        pool.Add("second");

        Assert.Equal("second", pool.TryTake());
        Assert.Equal("first", pool.TryTake());
        Assert.Null(pool.TryTake());
    }

    [Fact]
    public void Several_links_in_one_header_are_told_apart_and_resolved()
    {
        var links = AcmeTransport.ParseLinks(
            ["<https://ca.test/cert/1/alt/1>;rel=\"alternate\", </directory>; rel=index, <https://ca.test/terms>; title=\"a, b\"; rel=\"terms-of-service\""],
            new Uri("https://ca.test/cert/1"));

        Assert.Equal(
            [
                new AcmeLink(new Uri("https://ca.test/cert/1/alt/1"), "alternate"),
                new AcmeLink(new Uri("https://ca.test/directory"), "index"),
                new AcmeLink(new Uri("https://ca.test/terms"), "terms-of-service"),
            ],
            links);
    }

    [Fact]
    public void A_link_without_a_relation_or_a_broken_one_is_skipped()
    {
        var links = AcmeTransport.ParseLinks(["<https://ca.test/a>", "garbage", "<https://ca.test/b"], new Uri("https://ca.test/"));

        Assert.Empty(links);
    }
}
