using Runova.ServerCore.Certificates.Acme;

namespace Runova.ServerCore.Tests.Certificates.Acme;

/// <summary>
/// Domains reach the core as ASCII (punycode for international names). Anything else is refused
/// before it can reach the CA, a CSR or a challenge publisher.
/// </summary>
public sealed class AcmeIdentifierTests
{
    [Fact]
    public void Domains_are_lowercased_stripped_of_a_trailing_dot_and_deduplicated()
    {
        var identifiers = AcmeIdentifier.ForDomains(["Example.COM.", "www.example.com", "example.com"]);

        Assert.Equal(["example.com", "www.example.com"], identifiers.Select(identifier => identifier.Value));
        Assert.All(identifiers, identifier => Assert.Equal("dns", identifier.Type));
    }

    [Theory]
    [InlineData("*.example.com")]
    [InlineData("xn--bcher-kva.example")]
    [InlineData("a-b.c1.example")]
    public void Valid_names_are_accepted(string domain)
    {
        Assert.Equal(domain, Assert.Single(AcmeIdentifier.ForDomains([domain])).Value);
    }

    [Theory]
    [InlineData("")]
    [InlineData("localhost")]
    [InlineData("bücher.example")]
    [InlineData("under_score.example")]
    [InlineData("-leading.example")]
    [InlineData("trailing-.example")]
    [InlineData("double..dot.example")]
    [InlineData("a.*.example")]
    [InlineData("*example.com")]
    [InlineData("example.com/../etc")]
    [InlineData("example.com\r\nHost: evil")]
    [InlineData("1.2.3.4 example")]
    public void Anything_that_is_not_a_plain_dns_name_is_refused(string domain)
    {
        Assert.Throws<ArgumentException>(() => AcmeIdentifier.ForDomains([domain]));
    }

    [Fact]
    public void Labels_longer_than_63_and_names_longer_than_253_are_refused()
    {
        Assert.Throws<ArgumentException>(() => AcmeIdentifier.ForDomains([new string('a', 64) + ".example"]));
        var longName = string.Join('.', Enumerable.Repeat(new string('a', 60), 5));
        Assert.Throws<ArgumentException>(() => AcmeIdentifier.ForDomains([longName]));
    }

    [Fact]
    public void An_order_needs_at_least_one_and_at_most_100_names()
    {
        Assert.Throws<ArgumentException>(() => AcmeIdentifier.ForDomains([]));
        var many = Enumerable.Range(0, 101).Select(i => $"site{i}.example").ToArray();
        Assert.Throws<ArgumentException>(() => AcmeIdentifier.ForDomains(many));
    }
}
