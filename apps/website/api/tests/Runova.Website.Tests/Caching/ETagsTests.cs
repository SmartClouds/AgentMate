using Runova.Website.Core.Caching;

namespace Runova.Website.Tests.Caching;

public class ETagsTests
{
    private static readonly DateTimeOffset _newest = new(2026, 10, 29, 9, 30, 0, TimeSpan.Zero);

    [Fact]
    public void A_list_tag_is_weak_and_quoted()
    {
        Assert.Matches("^W/\"[0-9a-f]{32}\"$", ETags.ForList("/api/v1/news?category=security", _newest, 3));
    }

    [Fact]
    public void The_same_list_gets_the_same_tag()
    {
        Assert.Equal(ETags.ForList("/api/v1/news", _newest, 3), ETags.ForList("/api/v1/news", _newest, 3));
    }

    [Fact]
    public void Another_query_newest_update_or_count_gets_another_tag()
    {
        var tag = ETags.ForList("/api/v1/news", _newest, 3);

        Assert.NotEqual(tag, ETags.ForList("/api/v1/news?page=2", _newest, 3));
        Assert.NotEqual(tag, ETags.ForList("/api/v1/news", _newest.AddMilliseconds(1), 3));
        Assert.NotEqual(tag, ETags.ForList("/api/v1/news", _newest, 4));
        Assert.NotEqual(tag, ETags.ForList("/api/v1/news", null, 3));
    }

    [Fact]
    public void An_empty_list_has_a_tag_too()
    {
        Assert.Matches("^W/\"[0-9a-f]{32}\"$", ETags.ForList("/api/v1/news", null, 0));
    }

    [Fact]
    public void A_content_tag_is_strong_and_follows_the_content()
    {
        var tag = ETags.ForContent("runova|Runova|app|true");

        Assert.Matches("^\"[0-9a-f]{32}\"$", tag);
        Assert.Equal(tag, ETags.ForContent("runova|Runova|app|true"));
        Assert.NotEqual(tag, ETags.ForContent("runova|Runova|app|false"));
    }
}
