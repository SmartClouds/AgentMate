using Runova.Website.Core.Paging;

namespace Runova.Website.Tests.Paging;

public class PageTests
{
    [Theory]
    [InlineData(0, 20, 0)]
    [InlineData(1, 20, 1)]
    [InlineData(20, 20, 1)]
    [InlineData(21, 20, 2)]
    [InlineData(134, 20, 7)]
    public void Total_pages_rounds_up(int totalItems, int pageSize, int totalPages)
    {
        var page = Page.Of<int>([], new PageRequest(1, pageSize), totalItems);

        Assert.Equal(totalPages, page.TotalPages);
        Assert.Equal(totalItems, page.TotalItems);
        Assert.Equal(pageSize, page.PageSize);
    }

    [Theory]
    [InlineData(null, null, 1, 20)]
    [InlineData(3, 100, 3, 100)]
    public void A_request_defaults_to_page_1_of_20(int? page, int? pageSize, int expectedPage, int expectedSize)
    {
        var request = PageRequest.Parse(page, pageSize, out var errors);

        Assert.Empty(errors);
        Assert.Equal(new PageRequest(expectedPage, expectedSize), request);
        Assert.Equal((expectedPage - 1) * expectedSize, request.Skip);
    }

    [Theory]
    [InlineData(0, 20, "page")]
    [InlineData(1, 0, "pageSize")]
    [InlineData(1, 101, "pageSize")]
    public void A_request_out_of_range_names_the_field(int page, int pageSize, string field)
    {
        PageRequest.Parse(page, pageSize, out var errors);

        Assert.Equal([field], errors.Keys);
    }
}
