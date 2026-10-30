using System.Text.Json.Serialization;

namespace Runova.Website.Core.Paging;

/// <summary>One page of a list, as the contract's paging section shows it.</summary>
public sealed record Page<T>(
    IReadOnlyList<T> Items,
    [property: JsonPropertyName("page")] int Number,
    int PageSize,
    int TotalItems,
    int TotalPages);

public static class Page
{
    public static Page<T> Of<T>(IReadOnlyList<T> items, PageRequest request, int totalItems) =>
        new(items, request.Number, request.Size, totalItems, (totalItems + request.Size - 1) / request.Size);
}

/// <summary>The <c>page</c> and <c>pageSize</c> a list was asked for, 1-based.</summary>
public sealed record PageRequest(int Number, int Size)
{
    public const int DefaultSize = 20;
    public const int MaxSize = 100;

    public int Skip => (Number - 1) * Size;

    /// <summary>
    /// Fills in the defaults. A value out of range is named in <paramref name="errors"/> by its
    /// query parameter, and the request that comes back must not be used.
    /// </summary>
    public static PageRequest Parse(int? page, int? pageSize, out Dictionary<string, string[]> errors)
    {
        errors = [];
        if (page < 1)
        {
            errors["page"] = ["page starts at 1."];
        }

        if (pageSize is < 1 or > MaxSize)
        {
            errors["pageSize"] = [$"pageSize is from 1 to {MaxSize}."];
        }

        return new PageRequest(page ?? 1, pageSize ?? DefaultSize);
    }
}
