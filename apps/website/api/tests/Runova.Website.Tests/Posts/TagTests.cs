using Runova.Website.Core.Posts;

namespace Runova.Website.Tests.Posts;

public class TagTests
{
    [Theory]
    [InlineData("Docker", "docker")]
    [InlineData("AI Agents", "ai-agents")]
    [InlineData("  C# / .NET  ", "c-net")]
    [InlineData("Node.js", "node-js")]
    [InlineData("---", "")]
    public void A_name_gets_a_lowercase_hyphenated_slug(string name, string slug)
    {
        Assert.Equal(slug, Tag.SlugFor(name));
    }
}
