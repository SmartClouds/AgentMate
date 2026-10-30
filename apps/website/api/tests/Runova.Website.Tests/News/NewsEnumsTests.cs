using Runova.Website.Core;
using Runova.Website.Core.News;

namespace Runova.Website.Tests.News;

public class NewsEnumsTests
{
    [Fact]
    public void Categories_are_the_contract_strings()
    {
        Assert.Equal(
            ["security", "release", "deprecation", "end-of-life", "ai", "tooling", "industry"],
            Enum.GetValues<NewsCategory>().Select(ApiEnums.Name));
    }

    [Fact]
    public void Severities_are_the_contract_strings_from_lowest_to_highest()
    {
        Assert.Equal(
            ["info", "low", "medium", "high", "critical"],
            Enum.GetValues<NewsSeverity>().Order().Select(ApiEnums.Name));
    }

    [Fact]
    public void Statuses_are_the_contract_strings()
    {
        Assert.Equal(["draft", "scheduled", "published", "archived"], Enum.GetValues<NewsStatus>().Select(ApiEnums.Name));
    }

    [Fact]
    public void Technology_kinds_are_the_contract_strings()
    {
        Assert.Equal(
            ["app", "runtime", "tool", "ai-cli", "service", "server", "library", "os"],
            Enum.GetValues<TechnologyKind>().Select(ApiEnums.Name));
    }

    [Theory]
    [InlineData("end-of-life", true)]
    [InlineData("security", true)]
    [InlineData("Security", false)]
    [InlineData("EndOfLife", false)]
    [InlineData("0", false)]
    [InlineData("", false)]
    public void Parsing_takes_only_the_contract_strings(string text, bool parses)
    {
        Assert.Equal(parses, ApiEnums.TryParse<NewsCategory>(text, out _));
    }
}
