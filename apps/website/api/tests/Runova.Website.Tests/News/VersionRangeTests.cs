using Runova.Website.Core.News;

namespace Runova.Website.Tests.News;

public class VersionRangeTests
{
    [Theory]
    [InlineData("*")]
    [InlineData(">=9.8.0 <10.3.0")]
    [InlineData(">=2.40.0 <2.47.1 || =2.39.5")]
    [InlineData("<=1")]
    [InlineData(">1.2.3.4")]
    [InlineData("=v24.3.0")]
    public void A_range_in_the_grammar_parses(string text)
    {
        Assert.True(VersionRange.TryParse(text, out var range));
        Assert.NotNull(range);
    }

    [Theory]
    [InlineData("")]
    [InlineData(" ")]
    [InlineData("9.8.0")]
    [InlineData(">= 9.8.0")]
    [InlineData(">=9.8.0  <10.3.0")]
    [InlineData(">=9.8.0 <10.3.0 ")]
    [InlineData(">=9.8.0 ||")]
    [InlineData("|| <1.0.0")]
    [InlineData(">=9.8.0||<1.0.0")]
    [InlineData("~1.2.3")]
    [InlineData("^1.2.3")]
    [InlineData(">=latest")]
    [InlineData("<1.2.3.4.5")]
    [InlineData("<2.47.1.windows.1")]
    [InlineData("* <1.0.0")]
    [InlineData("=")]
    public void Anything_else_does_not_parse(string text)
    {
        Assert.False(VersionRange.TryParse(text, out var range));
        Assert.Null(range);
    }

    [Theory]
    [InlineData("*", "0.0.1", true)]
    [InlineData("*", "anything-1", false)]
    [InlineData(">=9.8.0 <10.3.0", "9.8.0", true)]
    [InlineData(">=9.8.0 <10.3.0", "10.2.99", true)]
    [InlineData(">=9.8.0 <10.3.0", "10.3.0", false)]
    [InlineData(">=9.8.0 <10.3.0", "9.7", false)]
    [InlineData(">=2.40.0 <2.47.1 || =2.39.5", "2.39.5", true)]
    [InlineData(">=2.40.0 <2.47.1 || =2.39.5", "2.39.4", false)]
    [InlineData("<2.47.1", "2.47.1.windows.1", false)]
    [InlineData("<2.47.1", "2.47.0.windows.2", true)]
    [InlineData("=24.3.0", "v24.3.0", true)]
    [InlineData(">=10.0.400", "10.0.401", true)]
    [InlineData("=1.2", "1.2.0.0", true)]
    [InlineData(">1.2.3", "1.2.3.1", true)]
    [InlineData("<=1.2.3", "1.2.3", true)]
    [InlineData(">=1.0.0", "", false)]
    [InlineData(">=1.0.0", "latest", false)]
    [InlineData(">=0.0.0", "vv1.0.0", false)]
    public void A_range_holds_for_the_versions_it_names(string range, string version, bool expected)
    {
        Assert.True(VersionRange.TryParse(range, out var parsed));
        Assert.Equal(expected, parsed!.IsSatisfiedBy(version));
    }
}
