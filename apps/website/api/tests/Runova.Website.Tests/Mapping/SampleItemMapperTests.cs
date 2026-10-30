using Runova.Website.Core.Samples;

namespace Runova.Website.Tests.Mapping;

public class SampleItemMapperTests
{
    private static readonly SampleItem _item = new()
    {
        Id = 42,
        Name = "First item",
        SecretHash = "c2VjcmV0",
        CreatedAt = new DateTimeOffset(2026, 10, 30, 12, 0, 0, TimeSpan.Zero),
    };

    [Fact]
    public void ToDto_copies_every_public_field()
    {
        var dto = SampleItemMapper.ToDto(_item);

        Assert.Equal(new SampleItemDto(42, "First item", _item.CreatedAt), dto);
    }

    [Fact]
    public void The_dto_carries_no_secret()
    {
        Assert.Empty(SecretProperties.In(typeof(SampleItemDto)));
    }

    [Fact]
    public void The_secret_check_finds_a_secret_on_the_source()
    {
        Assert.Equal(["SecretHash"], SecretProperties.In(typeof(SampleItem)));
    }
}
