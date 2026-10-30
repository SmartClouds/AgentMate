using Runova.Website.Core.Media;
using Runova.Website.Core.News;
using Runova.Website.Core.Posts;

namespace Runova.Website.Tests.Mapping;

public class PostMapperTests
{
    private const string Url = "https://runovahq.com/blog/hello-blog";

    private static readonly DateTimeOffset _publishedAt = new(2026, 10, 29, 8, 0, 0, TimeSpan.Zero);
    private static readonly CoverImageDto _cover = new("https://runovahq.com/media/2026/10/abc.png", 40, 20, "A blue square");

    private static Post Item() => new()
    {
        Id = 7,
        Slug = "hello-blog",
        Title = "Hello, blog",
        Excerpt = "The first post on the new blog.",
        BodyMarkdown = "## Hello",
        BodyHtml = "<h2 id=\"hello\">Hello</h2>",
        AuthorName = "Sam Writer",
        Tags = [new Tag { Id = 1, Slug = "docker", Name = "Docker" }],
        Status = NewsStatus.Published,
        PublishedAt = _publishedAt,
        UpdatedAt = _publishedAt.AddHours(1),
        CreatedAt = _publishedAt.AddDays(-1),
        ReadingTimeMinutes = 3,
        Version = 99,
    };

    [Fact]
    public void A_list_item_has_the_public_fields()
    {
        var dto = PostMapper.ToListItemDto(Item(), Url, _cover);

        Assert.Equal(7, dto.Id);
        Assert.Equal("hello-blog", dto.Slug);
        Assert.Equal(Url, dto.Url);
        Assert.Equal("Hello, blog", dto.Title);
        Assert.Equal("The first post on the new blog.", dto.Excerpt);
        Assert.Equal(_cover, dto.CoverImage);
        Assert.Equal([new PostTagDto("docker", "Docker")], dto.Tags);
        Assert.Equal(new PostAuthorDto("Sam Writer"), dto.Author);
        Assert.Equal(_publishedAt, dto.PublishedAt);
        Assert.Equal(3, dto.ReadingTimeMinutes);
    }

    [Fact]
    public void A_post_adds_the_html_and_an_admin_dto_the_markdown_status_creator_and_version()
    {
        var creator = new NewsCreatorDto("user", 3, "Sam Writer");

        var dto = PostMapper.ToDto(Item(), Url, null);
        var admin = PostMapper.ToAdminDto(Item(), Url, null, creator);

        Assert.Null(dto.CoverImage);
        Assert.Equal("<h2 id=\"hello\">Hello</h2>", dto.BodyHtml);
        Assert.Equal("## Hello", admin.BodyMarkdown);
        Assert.Equal(NewsStatus.Published, admin.Status);
        Assert.Equal(_publishedAt.AddDays(-1), admin.CreatedAt);
        Assert.Equal(creator, admin.CreatedBy);
        Assert.Equal("99", admin.Version);
    }

    [Fact]
    public void A_media_file_maps_to_its_dto()
    {
        var file = new MediaFile
        {
            Id = 5,
            Path = "2026/10/abc.png",
            ContentType = "image/png",
            Width = 40,
            Height = 20,
            Size = 1234,
            Alt = "A blue square",
            CreatedAt = _publishedAt,
        };

        var dto = MediaMapper.ToDto(file, "https://runovahq.com/media/2026/10/abc.png");

        Assert.Equal(new MediaDto(5, "https://runovahq.com/media/2026/10/abc.png", "image/png", 40, 20, 1234, "A blue square", _publishedAt), dto);
        Assert.Equal(new CoverImageDto(dto.Url, 40, 20, "A blue square"), MediaMapper.ToCoverImageDto(file, dto.Url));
    }

    [Fact]
    public void The_dtos_carry_no_secret()
    {
        Assert.Empty(SecretProperties.In(typeof(PostListItemDto)));
        Assert.Empty(SecretProperties.In(typeof(PostDto)));
        Assert.Empty(SecretProperties.In(typeof(PostAdminDto)));
        Assert.Empty(SecretProperties.In(typeof(TagDto)));
        Assert.Empty(SecretProperties.In(typeof(MediaDto)));
    }
}
