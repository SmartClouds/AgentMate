using System.Text.RegularExpressions;
using Runova.Website.Core;
using Runova.Website.Core.News;

namespace Runova.Website.Tests.News;

public partial class TechnologiesTests
{
    [Fact]
    public void The_list_matches_the_contract_table_in_its_order()
    {
        var rows = ContractRow().Matches(Contract.Read())
            .Select(m => (m.Groups["slug"].Value, m.Groups["name"].Value, m.Groups["kind"].Value, m.Groups["detectable"].Value == "yes"))
            .ToList();

        Assert.Equal(50, rows.Count);
        Assert.Equal(rows, Technologies.All.Select(t => (t.Slug, t.Name, ApiEnums.Name(t.Kind), t.Detectable)));
    }

    [Fact]
    public void Ids_are_fixed_and_follow_the_table()
    {
        Assert.Equal(Enumerable.Range(1, Technologies.All.Count).Select(i => (long)i), Technologies.All.Select(t => t.Id));
    }

    [Theory]
    [InlineData("openssh", "OpenSSH")]
    [InlineData("claude-code", "Claude Code")]
    public void Find_looks_up_a_slug(string slug, string name)
    {
        Assert.Equal(name, Technologies.Find(slug)?.Name);
    }

    [Theory]
    [InlineData("node")]
    [InlineData("OpenSSH")]
    public void Find_knows_nothing_outside_the_list(string slug)
    {
        Assert.Null(Technologies.Find(slug));
    }

    [GeneratedRegex(@"^\| `(?<slug>[a-z0-9-]+)` \| (?<name>[^|]+?) \| (?<kind>[a-z-]+) \| (?<detectable>yes|no) \|$", RegexOptions.Multiline)]
    private static partial Regex ContractRow();
}
