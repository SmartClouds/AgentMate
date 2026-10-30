using AngleSharp.Dom;
using AngleSharp.Html.Parser;
using Runova.Website.Core.Content;

namespace Runova.Website.Tests.Content;

public class MarkdownRendererTests
{
    private static readonly MarkdownRenderer _renderer = new(new Uri("https://runovahq.com"));

    private static readonly string[] _forbiddenElements = ["script", "iframe", "object", "embed", "form", "style"];

    [Fact]
    public void Renders_headings_emphasis_lists_and_links()
    {
        var html = _renderer.Render("## What happened\n\nUpdate **now**.\n\n- one\n- two\n\nSee [the notes](/news/openssh).");

        var document = Parse(html);
        Assert.Equal("What happened", document.QuerySelector("h2")?.TextContent);
        Assert.Equal("now", document.QuerySelector("strong")?.TextContent);
        Assert.Equal(2, document.QuerySelectorAll("ul > li").Length);
        Assert.Equal("/news/openssh", document.QuerySelector("a")?.GetAttribute("href"));
    }

    [Fact]
    public void Keeps_code_blocks_and_tables()
    {
        var html = _renderer.Render("```js\nconst a = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");

        var document = Parse(html);
        Assert.Equal("language-js", document.QuerySelector("pre > code")?.GetAttribute("class"));
        Assert.Equal(2, document.QuerySelectorAll("table td").Length);
    }

    [Fact]
    public void Raw_html_in_the_markdown_is_shown_as_text()
    {
        var html = _renderer.Render("Some <b>bold</b> words");

        Assert.Null(Parse(html).QuerySelector("b"));
        Assert.Contains("&lt;b&gt;", html, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("<script>alert(1)</script>")]
    [InlineData("<iframe src=\"https://evil.example\"></iframe>")]
    [InlineData("<object data=\"x\"></object><embed src=\"x\"><form action=\"x\"><input></form>")]
    [InlineData("<img src=x onerror=alert(1)>")]
    [InlineData("<a href=\"javascript:alert(1)\">x</a>")]
    [InlineData("[click](javascript:alert(1))")]
    [InlineData("[click](JaVaScRiPt:alert(1))")]
    [InlineData("[click]( javascript:alert(1) )")]
    [InlineData("[click](&#106;avascript:alert(1))")]
    [InlineData("![pixel](javascript:alert(1))")]
    [InlineData("<javascript:alert(1)>")]
    [InlineData("# Title {onclick=\"alert(1)\"}")]
    [InlineData("# Title {style=\"color:red\"}")]
    [InlineData("[x](https://example.com){onmouseover=\"alert(1)\"}")]
    [InlineData("```\n</code></pre><script>alert(1)</script>\n```")]
    public void Nothing_that_runs_script_survives(string markdown)
    {
        var html = _renderer.Render(markdown);

        var elements = Parse(html).QuerySelectorAll("*");
        Assert.DoesNotContain(elements, e => _forbiddenElements.Contains(e.LocalName));
        Assert.DoesNotContain(elements.SelectMany(e => e.Attributes), a => a.Name.StartsWith("on", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(elements.SelectMany(e => e.Attributes), a => a.Name == "style");
        Assert.DoesNotContain(
            elements.SelectMany(e => e.Attributes),
            a => a.Value.Trim().StartsWith("javascript:", StringComparison.OrdinalIgnoreCase));
    }

    [Theory]
    [InlineData("[notes](https://www.openssh.com/txt/release-10.3)")]
    [InlineData("<https://www.openssh.com>")]
    [InlineData("[evil](https://runovahq.com.evil.example/)")]
    public void External_links_get_noopener_noreferrer_nofollow(string markdown)
    {
        var link = Parse(_renderer.Render(markdown)).QuerySelector("a");

        Assert.Equal("noopener noreferrer nofollow", link?.GetAttribute("rel"));
    }

    [Theory]
    [InlineData("[news](/news)")]
    [InlineData("[news](https://runovahq.com/news)")]
    [InlineData("[top](#what-happened)")]
    public void Links_within_the_site_get_no_rel(string markdown)
    {
        var link = Parse(_renderer.Render(markdown)).QuerySelector("a");

        Assert.NotNull(link);
        Assert.Null(link.GetAttribute("rel"));
    }

    [Fact]
    public void A_rel_written_in_the_markdown_is_replaced()
    {
        var link = Parse(_renderer.Render("[x](https://example.com){rel=\"opener\"}")).QuerySelector("a");

        Assert.Equal("noopener noreferrer nofollow", link?.GetAttribute("rel"));
    }

    private static IDocument Parse(string html) => new HtmlParser().ParseDocument(html);
}
