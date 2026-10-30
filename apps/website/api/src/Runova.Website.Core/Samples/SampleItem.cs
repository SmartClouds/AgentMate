namespace Runova.Website.Core.Samples;

/// <summary>
/// The sample the first mapper works on, so the Mapperly setup and its secret check have
/// something to run against before the real resources arrive. Remove it once one of them has a mapper.
/// </summary>
public sealed class SampleItem
{
    public long Id { get; init; }

    public required string Name { get; init; }

    /// <summary>Stands for the hashes and keys a DTO must never carry.</summary>
    public required string SecretHash { get; init; }

    public DateTimeOffset CreatedAt { get; init; }
}

public sealed record SampleItemDto(long Id, string Name, DateTimeOffset CreatedAt);
