using Runova.Website.Core.News;

namespace Runova.Website.Tests.News;

public class NewsListQueryTests
{
    [Fact]
    public void No_parameters_mean_published_news_newest_first_twenty_a_page()
    {
        var query = NewsListQuery.Parse(new NewsListParameters(), out var errors);

        Assert.Empty(errors);
        Assert.Empty(query.Categories);
        Assert.Empty(query.Severities);
        Assert.Null(query.MinSeverity);
        Assert.Empty(query.Technologies);
        Assert.Empty(query.Tags);
        Assert.Null(query.Since);
        Assert.Null(query.Search);
        Assert.Empty(query.Statuses);
        Assert.Equal(NewsSort.Newest, query.Sort);
        Assert.Equal(1, query.Page.Number);
        Assert.Equal(20, query.Page.Size);
    }

    [Fact]
    public void Repeated_values_are_all_kept()
    {
        var query = NewsListQuery.Parse(
            new NewsListParameters(
                Category: ["security", "end-of-life"],
                Severity: ["high", "critical"],
                Technology: ["openssh", "git"],
                Tag: ["ssh", "servers"],
                Status: ["draft", "scheduled"]),
            out var errors);

        Assert.Empty(errors);
        Assert.Equal([NewsCategory.Security, NewsCategory.EndOfLife], query.Categories);
        Assert.Equal([NewsSeverity.High, NewsSeverity.Critical], query.Severities);
        Assert.Equal(["openssh", "git"], query.Technologies);
        Assert.Equal(["ssh", "servers"], query.Tags);
        Assert.Equal([NewsStatus.Draft, NewsStatus.Scheduled], query.Statuses);
    }

    [Fact]
    public void Repeating_a_value_keeps_it_once()
    {
        var query = NewsListQuery.Parse(new NewsListParameters(Category: ["ai", "ai"], Tag: ["ssh", "ssh"]), out _);

        Assert.Equal([NewsCategory.Ai], query.Categories);
        Assert.Equal(["ssh"], query.Tags);
    }

    [Theory]
    [InlineData("-publishedAt", NewsSort.Newest)]
    [InlineData("publishedAt", NewsSort.Oldest)]
    [InlineData("-severity", NewsSort.Severity)]
    public void Sort_takes_the_contract_values(string sort, NewsSort expected)
    {
        Assert.Equal(expected, NewsListQuery.Parse(new NewsListParameters(Sort: sort), out _).Sort);
    }

    [Fact]
    public void Min_severity_since_and_search_are_read()
    {
        var query = NewsListQuery.Parse(
            new NewsListParameters(MinSeverity: "medium", Since: "2026-10-29T08:00:00.000Z", Q: "  pre-auth crash  ", Page: 3, PageSize: 100),
            out var errors);

        Assert.Empty(errors);
        Assert.Equal(NewsSeverity.Medium, query.MinSeverity);
        Assert.Equal(new DateTimeOffset(2026, 10, 29, 8, 0, 0, TimeSpan.Zero), query.Since);
        Assert.Equal("pre-auth crash", query.Search);
        Assert.Equal(new(3, 100), query.Page);
    }

    [Fact]
    public void Since_with_an_offset_is_read_as_that_instant()
    {
        var query = NewsListQuery.Parse(new NewsListParameters(Since: "2026-10-29T10:00:00+02:00"), out _);

        Assert.Equal(new DateTimeOffset(2026, 10, 29, 8, 0, 0, TimeSpan.Zero), query.Since);
    }

    [Fact]
    public void A_blank_search_is_no_search()
    {
        Assert.Null(NewsListQuery.Parse(new NewsListParameters(Q: "   "), out _).Search);
    }

    [Theory]
    [InlineData("category", "Unknown category 'bogus'.")]
    [InlineData("severity", "Unknown severity 'bogus'.")]
    [InlineData("minSeverity", "Unknown severity 'bogus'.")]
    [InlineData("technology", "Unknown technology slug 'bogus'.")]
    [InlineData("status", "Unknown status 'bogus'.")]
    [InlineData("sort", "sort is -publishedAt, publishedAt or -severity.")]
    [InlineData("since", "since is an RFC 3339 time, such as 2026-10-30T12:00:00.000Z.")]
    public void An_unknown_value_names_its_parameter(string parameter, string message)
    {
        string[] bogus = ["bogus"];
        var parameters = parameter switch
        {
            "category" => new NewsListParameters(Category: bogus),
            "severity" => new NewsListParameters(Severity: bogus),
            "minSeverity" => new NewsListParameters(MinSeverity: "bogus"),
            "technology" => new NewsListParameters(Technology: bogus),
            "status" => new NewsListParameters(Status: bogus),
            "sort" => new NewsListParameters(Sort: "bogus"),
            _ => new NewsListParameters(Since: "bogus"),
        };

        NewsListQuery.Parse(parameters, out var errors);

        Assert.Equal([parameter], errors.Keys);
        Assert.Equal([message], errors[parameter]);
    }

    [Theory]
    [InlineData("a")]
    [InlineData(" a ")]
    public void A_search_under_two_characters_is_refused(string q)
    {
        NewsListQuery.Parse(new NewsListParameters(Q: q), out var errors);

        Assert.Equal(["q is 2 to 100 characters."], errors["q"]);
    }

    [Fact]
    public void A_search_over_a_hundred_characters_is_refused()
    {
        NewsListQuery.Parse(new NewsListParameters(Q: new string('x', 101)), out var errors);

        Assert.Equal(["q is 2 to 100 characters."], errors["q"]);
    }

    [Theory]
    [InlineData(0, 20, "page")]
    [InlineData(1, 0, "pageSize")]
    [InlineData(1, 101, "pageSize")]
    public void Paging_out_of_range_is_refused(int page, int pageSize, string parameter)
    {
        NewsListQuery.Parse(new NewsListParameters(Page: page, PageSize: pageSize), out var errors);

        Assert.Equal([parameter], errors.Keys);
    }

    [Fact]
    public void Every_bad_parameter_is_reported_at_once()
    {
        NewsListQuery.Parse(new NewsListParameters(Category: ["bogus"], Technology: ["node"], PageSize: 500), out var errors);

        Assert.Equal(["category", "pageSize", "technology"], errors.Keys.Order(StringComparer.Ordinal));
    }
}
