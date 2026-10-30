using System.Text.RegularExpressions;
using Runova.Website.Core.Problems;

namespace Runova.Website.Tests.Problems;

public partial class ProblemTypesTests
{
    [Fact]
    public void The_catalog_matches_the_contract_table()
    {
        var contract = File.ReadAllText(FindContract());
        var rows = ContractRow().Matches(contract)
            .Select(m => (m.Groups["slug"].Value, int.Parse(m.Groups["status"].Value, System.Globalization.CultureInfo.InvariantCulture)))
            .ToList();

        Assert.NotEmpty(rows);
        Assert.Equal(rows, ProblemTypes.All.Select(t => (t.Slug, t.Status)));
    }

    [Theory]
    [InlineData(400, "validation-failed")]
    [InlineData(401, "unauthorized")]
    [InlineData(404, "not-found")]
    [InlineData(500, "internal")]
    [InlineData(503, "unavailable")]
    public void ForStatus_picks_the_general_type_of_a_status(int status, string slug)
    {
        Assert.Equal(slug, ProblemTypes.ForStatus(status)?.Slug);
    }

    [Fact]
    public void ForStatus_has_nothing_for_a_status_outside_the_contract()
    {
        Assert.Null(ProblemTypes.ForStatus(405));
    }

    [Fact]
    public void Every_type_is_a_uri_under_the_problems_base()
    {
        Assert.All(ProblemTypes.All, t => Assert.Equal("https://runovahq.com/problems/" + t.Slug, t.Uri));
    }

    [GeneratedRegex(@"^\| `(?<slug>[a-z-]+)` \| (?<status>\d{3}) \|", RegexOptions.Multiline)]
    private static partial Regex ContractRow();

    private static string FindContract()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "docs", "website", "api-contract.md");
            if (File.Exists(candidate))
            {
                return candidate;
            }
        }

        throw new FileNotFoundException("docs/website/api-contract.md was not found above the test binary.");
    }
}
