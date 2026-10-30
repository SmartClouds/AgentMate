using Runova.Website.Core.Posts;

namespace Runova.Website.Tests.Posts;

public class ReadingTimeTests
{
    [Theory]
    [InlineData(0, 1)]
    [InlineData(1, 1)]
    [InlineData(230, 1)]
    [InlineData(231, 2)]
    [InlineData(460, 2)]
    [InlineData(461, 3)]
    public void It_is_the_word_count_over_230_rounded_up_and_at_least_1(int words, int minutes)
    {
        var body = string.Join(' ', Enumerable.Repeat("word", words));

        Assert.Equal(minutes, ReadingTime.Minutes(body));
    }

    [Fact]
    public void Markdown_marks_on_their_own_are_not_words()
    {
        var body = "## Heading\n\n- one\n- two\n\n---\n\n> quote **bold** text";

        Assert.Equal(6, ReadingTime.Words(body));
    }

    [Fact]
    public void Any_whitespace_separates_words()
    {
        Assert.Equal(4, ReadingTime.Words("one\ttwo\nthree   four\r\n"));
    }
}
