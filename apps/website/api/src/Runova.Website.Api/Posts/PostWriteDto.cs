using System.ComponentModel.DataAnnotations;
using Microsoft.Extensions.Validation;
using Runova.Website.Core.News;
using Runova.Website.Core.Posts;

namespace Runova.Website.Api.Posts;

/// <summary>
/// The body of a post write: the contract's <c>PostWriteDto</c>. Every property is nullable, so a
/// missing field is named by validation rather than lost in a JSON error. The rules that need the
/// database (a unique slug, a cover that exists) are checked by the endpoint.
/// </summary>
// The endpoints read the body themselves, so the validation generator only finds the type by this
// attribute, which .NET 10 still marks as experimental.
#pragma warning disable ASP0029
[ValidatableType]
#pragma warning restore ASP0029
public sealed class PostWriteDto : IValidatableObject
{
    public const int MaxTags = 10;

    [Required(ErrorMessage = "Enter a slug.")]
    [StringLength(120, MinimumLength = 3, ErrorMessage = "A slug is 3 to 120 characters.")]
    [RegularExpression("^(?=.*[a-z])[a-z0-9]+(-[a-z0-9]+)*$", ErrorMessage = "A slug is a-z, 0-9 and single hyphens, with at least one letter.")]
    public string? Slug { get; init; }

    [Required(ErrorMessage = "Enter a title.")]
    [StringLength(160, MinimumLength = 5, ErrorMessage = "A title is 5 to 160 characters.")]
    public string? Title { get; init; }

    [Required(ErrorMessage = "Enter an excerpt.")]
    [StringLength(300, MinimumLength = 20, ErrorMessage = "An excerpt is 20 to 300 characters.")]
    public string? Excerpt { get; init; }

    [StringLength(100_000, ErrorMessage = "The body is at most 100,000 characters.")]
    public string? BodyMarkdown { get; init; }

    /// <summary>An uploaded media id, or null for a post with no cover.</summary>
    public long? CoverMediaId { get; init; }

    /// <summary>Tag names; one whose slug no tag has yet makes a new tag.</summary>
    [MaxLength(MaxTags, ErrorMessage = "Give at most 10 tags.")]
    public List<string>? Tags { get; init; }

    [Required(ErrorMessage = "Choose a status.")]
    public NewsStatus? Status { get; init; }

    public DateTimeOffset? PublishedAt { get; init; }

    /// <summary>The rules across fields and inside lists, once every attribute above holds.</summary>
    public IEnumerable<ValidationResult> Validate(ValidationContext validationContext)
    {
        var now = (validationContext.GetService(typeof(TimeProvider)) as TimeProvider ?? TimeProvider.System).GetUtcNow();

        for (var i = 0; i < Tags?.Count; i++)
        {
            if (Tags[i]?.Trim() is not { Length: >= 2 and <= 32 } name || Tag.SlugFor(name).Length == 0)
            {
                yield return new("A tag is 2 to 32 characters with a letter or digit in it.", [$"{nameof(Tags)}[{i}]"]);
            }
        }

        switch (Status)
        {
            case NewsStatus.Archived:
                yield return new("Archive a post with DELETE.", [nameof(Status)]);
                break;
            case NewsStatus.Scheduled when PublishedAt is not { } at || at <= now:
                yield return new("A scheduled post needs a publishedAt in the future.", [nameof(PublishedAt)]);
                break;
            case NewsStatus.Published when PublishedAt > now:
                yield return new("A published post can not have a future publishedAt. Schedule it instead.", [nameof(PublishedAt)]);
                break;
        }
    }
}
