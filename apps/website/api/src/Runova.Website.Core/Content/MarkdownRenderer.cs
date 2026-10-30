using AngleSharp.Dom;
using Ganss.Xss;
using Markdig;

namespace Runova.Website.Core.Content;

/// <summary>
/// Turns a news item's or post's Markdown into the HTML the site shows. Markdig renders it with its
/// advanced extensions and raw HTML turned into text; HtmlSanitizer then removes anything that
/// could run script or post a form, including attributes an author adds with Markdig's <c>{...}</c> syntax.
/// Links off the site get <c>rel="noopener noreferrer nofollow"</c>. One instance serves every
/// request.
/// </summary>
public sealed class MarkdownRenderer
{
    private const string ExternalRel = "noopener noreferrer nofollow";

    private static readonly MarkdownPipeline _pipeline = new MarkdownPipelineBuilder()
        .UseAdvancedExtensions()
        .DisableHtml()
        .Build();

    private readonly string _siteHost;
    private readonly HtmlSanitizer _sanitizer;

    public MarkdownRenderer(Uri siteUrl)
    {
        _siteHost = siteUrl.Host;
        _sanitizer = new HtmlSanitizer();
        foreach (var tag in new[] { "form", "button", "select", "textarea", "option", "optgroup", "style" })
        {
            _sanitizer.AllowedTags.Remove(tag);
        }

        // The sanitizer sets rel itself, and no inline style gets through.
        _sanitizer.AllowedAttributes.Remove("rel");
        _sanitizer.AllowedAttributes.Remove("style");
        // Heading anchors and the language-* class on code blocks.
        _sanitizer.AllowedAttributes.Add("id");
        _sanitizer.AllowedAttributes.Add("class");
        _sanitizer.AllowedSchemes.Add("mailto");
        _sanitizer.PostProcessNode += (_, e) => MarkExternalLink(e.Node);
    }

    public string Render(string markdown) => _sanitizer.Sanitize(Markdown.ToHtml(markdown, _pipeline));

    private void MarkExternalLink(INode node)
    {
        if (node is IElement { LocalName: "a" } link
            && Uri.TryCreate(link.GetAttribute("href"), UriKind.Absolute, out var target)
            && target.Scheme is "http" or "https"
            && !string.Equals(target.Host, _siteHost, StringComparison.OrdinalIgnoreCase))
        {
            link.SetAttribute("rel", ExternalRel);
        }
    }
}
