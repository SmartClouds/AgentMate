using Runova.Website.Core.News;

namespace Runova.Website.Tests.Mapping;

public class NewsMapperTests
{
    private const string Url = "https://runovahq.com/news/openssh-10-3-fixes-a-pre-auth-crash";

    private static readonly DateTimeOffset _publishedAt = new(2026, 10, 29, 8, 0, 0, TimeSpan.Zero);
    private static readonly DateTimeOffset _updatedAt = new(2026, 10, 29, 9, 30, 0, TimeSpan.Zero);

    private static NewsItem Item() => new()
    {
        Id = 42,
        Slug = "openssh-10-3-fixes-a-pre-auth-crash",
        Title = "OpenSSH 10.3 fixes a pre-auth crash",
        Summary = "A crafted key exchange can crash sshd before sign-in. Update to 10.3.",
        BodyMarkdown = "## What happened",
        BodyHtml = "<h2 id=\"what-happened\">What happened</h2>",
        Category = NewsCategory.Security,
        Severity = NewsSeverity.High,
        Technologies = [new AffectedTechnology { Technology = "openssh", VersionRange = ">=9.8.0 <10.3.0", FixedIn = "10.3.0" }],
        CveIds = ["CVE-2026-41234"],
        CvssScore = 7.5m,
        SourceLinks = [new SourceLink { Title = "OpenSSH 10.3 release notes", Url = "https://www.openssh.com/txt/release-10.3" }],
        Tags = ["ssh", "servers"],
        Status = NewsStatus.Published,
        PublishedAt = _publishedAt,
        UpdatedAt = _updatedAt,
        Version = 1234,
    };

    [Fact]
    public void A_list_item_has_the_public_fields_and_the_technology_names()
    {
        var dto = NewsMapper.ToListItemDto(Item(), Url);

        Assert.Equal(42, dto.Id);
        Assert.Equal("openssh-10-3-fixes-a-pre-auth-crash", dto.Slug);
        Assert.Equal(Url, dto.Url);
        Assert.Equal("OpenSSH 10.3 fixes a pre-auth crash", dto.Title);
        Assert.Equal("A crafted key exchange can crash sshd before sign-in. Update to 10.3.", dto.Summary);
        Assert.Equal(NewsCategory.Security, dto.Category);
        Assert.Equal(NewsSeverity.High, dto.Severity);
        Assert.Equal([new AffectedTechnologyDto("openssh", "OpenSSH", ">=9.8.0 <10.3.0", "10.3.0")], dto.Technologies);
        Assert.Equal(["CVE-2026-41234"], dto.CveIds);
        Assert.Equal(7.5m, dto.CvssScore);
        Assert.Equal(["ssh", "servers"], dto.Tags);
        Assert.Equal(_publishedAt, dto.PublishedAt);
        Assert.Equal(_updatedAt, dto.UpdatedAt);
    }

    [Fact]
    public void An_item_adds_the_rendered_body_and_the_source_links()
    {
        var dto = NewsMapper.ToDto(Item(), Url);

        Assert.Equal(Url, dto.Url);
        Assert.Equal("<h2 id=\"what-happened\">What happened</h2>", dto.BodyHtml);
        Assert.Equal([new SourceLinkDto("OpenSSH 10.3 release notes", "https://www.openssh.com/txt/release-10.3")], dto.SourceLinks);
        Assert.Equal([new AffectedTechnologyDto("openssh", "OpenSSH", ">=9.8.0 <10.3.0", "10.3.0")], dto.Technologies);
        Assert.Equal(_publishedAt, dto.PublishedAt);
    }

    [Fact]
    public void An_item_with_no_fix_or_score_maps_them_to_null()
    {
        var item = Item();
        item.Technologies = [new AffectedTechnology { Technology = "git", VersionRange = "*" }];
        item.CvssScore = null;

        var dto = NewsMapper.ToListItemDto(item, Url);

        Assert.Equal([new AffectedTechnologyDto("git", "Git", "*", null)], dto.Technologies);
        Assert.Null(dto.CvssScore);
    }

    [Fact]
    public void A_public_dto_leaves_out_the_markdown_status_and_version()
    {
        string[] hidden = ["BodyMarkdown", "Status", "Version"];

        Assert.DoesNotContain(typeof(NewsListItemDto).GetProperties(), p => hidden.Contains(p.Name));
        Assert.DoesNotContain(typeof(NewsItemDto).GetProperties(), p => hidden.Contains(p.Name));
    }

    [Fact]
    public void The_dtos_carry_no_secret()
    {
        Assert.Empty(SecretProperties.In(typeof(NewsListItemDto)));
        Assert.Empty(SecretProperties.In(typeof(NewsItemDto)));
        Assert.Empty(SecretProperties.In(typeof(TechnologyDto)));
    }

    [Fact]
    public void A_technology_maps_to_its_dto()
    {
        var technology = Technologies.Find("claude-code")!;

        Assert.Equal(new TechnologyDto("claude-code", "Claude Code", TechnologyKind.AiCli, true), TechnologyMapper.ToDto(technology));
    }
}
