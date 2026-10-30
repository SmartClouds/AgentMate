using System.ComponentModel.DataAnnotations;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Validation;
using Runova.Website.Core.News;

namespace Runova.Website.Api.News;

/// <summary>
/// The body of a news write: the contract's <c>NewsItemWriteDto</c>. Every property is nullable,
/// so a missing field is named by validation rather than lost in a JSON error. The rules that need
/// the database (a unique slug) are checked by the endpoint.
/// </summary>
// The endpoints read the body themselves, so the validation generator only finds the type by this
// attribute, which .NET 10 still marks as experimental.
#pragma warning disable ASP0029
[ValidatableType]
#pragma warning restore ASP0029
public sealed partial class NewsItemWriteDto : IValidatableObject
{
    public const int MaxTechnologies = 20;
    public const int MaxSourceLinks = 10;
    public const int MaxTags = 10;

    [Required(ErrorMessage = "Enter a slug.")]
    [StringLength(120, MinimumLength = 3, ErrorMessage = "A slug is 3 to 120 characters.")]
    [RegularExpression("^(?=.*[a-z])[a-z0-9]+(-[a-z0-9]+)*$", ErrorMessage = "A slug is a-z, 0-9 and single hyphens, with at least one letter.")]
    public string? Slug { get; init; }

    [Required(ErrorMessage = "Enter a title.")]
    [StringLength(160, MinimumLength = 5, ErrorMessage = "A title is 5 to 160 characters.")]
    public string? Title { get; init; }

    [Required(ErrorMessage = "Enter a summary.")]
    [StringLength(400, MinimumLength = 20, ErrorMessage = "A summary is 20 to 400 characters.")]
    public string? Summary { get; init; }

    [StringLength(100_000, ErrorMessage = "The body is at most 100,000 characters.")]
    public string? BodyMarkdown { get; init; }

    [Required(ErrorMessage = "Choose a category.")]
    public NewsCategory? Category { get; init; }

    [Required(ErrorMessage = "Choose a severity.")]
    public NewsSeverity? Severity { get; init; }

    [MaxLength(MaxTechnologies, ErrorMessage = "Name at most 20 technologies.")]
    public List<AffectedTechnologyWriteDto>? Technologies { get; init; }

    public List<string>? CveIds { get; init; }

    [Range(0.0, 10.0, ErrorMessage = "A CVSS score is 0.0 to 10.0.")]
    public decimal? CvssScore { get; init; }

    [MaxLength(MaxSourceLinks, ErrorMessage = "Link at most 10 sources.")]
    public List<SourceLinkWriteDto>? SourceLinks { get; init; }

    [MaxLength(MaxTags, ErrorMessage = "Give at most 10 tags.")]
    public List<string>? Tags { get; init; }

    [Required(ErrorMessage = "Choose a status.")]
    public NewsStatus? Status { get; init; }

    public DateTimeOffset? PublishedAt { get; init; }

    /// <summary>
    /// The rules across fields and inside lists. The built-in validation runs these once every
    /// attribute above holds; member names are property paths, which the endpoint turns into JSON paths.
    /// </summary>
    public IEnumerable<ValidationResult> Validate(ValidationContext validationContext)
    {
        var now = (validationContext.GetService(typeof(TimeProvider)) as TimeProvider ?? TimeProvider.System).GetUtcNow();

        if (Category == NewsCategory.Security && Severity == NewsSeverity.Info)
        {
            yield return new("A security item needs a severity of low or higher.", [nameof(Severity)]);
        }
        else if (Category != NewsCategory.Security && Severity != NewsSeverity.Info)
        {
            yield return new("Only security items have a severity above info.", [nameof(Severity)]);
        }

        if (Category == NewsCategory.Security && Technologies is not { Count: > 0 })
        {
            yield return new("A security item names at least one affected technology.", [nameof(Technologies)]);
        }

        for (var i = 0; i < CveIds?.Count; i++)
        {
            if (CveIds[i] is not { } cve || !CvePattern().IsMatch(cve))
            {
                yield return new("A CVE id looks like CVE-2026-41234.", [$"{nameof(CveIds)}[{i}]"]);
            }
        }

        if (CvssScore is { } score && decimal.Round(score, 1) != score)
        {
            yield return new("A CVSS score has one decimal.", [nameof(CvssScore)]);
        }

        for (var i = 0; i < Tags?.Count; i++)
        {
            if (Tags[i] is not { } tag || !TagPattern().IsMatch(tag))
            {
                yield return new("A tag is 2 to 32 characters of a-z, 0-9 and hyphens.", [$"{nameof(Tags)}[{i}]"]);
            }
        }

        switch (Status)
        {
            case NewsStatus.Archived:
                yield return new("Archive an item with DELETE.", [nameof(Status)]);
                break;
            case NewsStatus.Scheduled when PublishedAt is not { } at || at <= now:
                yield return new("A scheduled item needs a publishedAt in the future.", [nameof(PublishedAt)]);
                break;
            case NewsStatus.Published when PublishedAt > now:
                yield return new("A published item can not have a future publishedAt. Schedule it instead.", [nameof(PublishedAt)]);
                break;
        }
    }

    [GeneratedRegex(@"^CVE-\d{4}-\d{4,}$")]
    private static partial Regex CvePattern();

    [GeneratedRegex("^[a-z0-9-]{2,32}$")]
    private static partial Regex TagPattern();
}

/// <summary>A technology the item affects: a slug from the list, a version range and the version that fixes it.</summary>
public sealed class AffectedTechnologyWriteDto : IValidatableObject
{
    [Required(ErrorMessage = "Choose a technology.")]
    public string? Technology { get; init; }

    [Required(ErrorMessage = "Enter a version range, or * for every version.")]
    [StringLength(100, ErrorMessage = "A version range is at most 100 characters.")]
    public string? VersionRange { get; init; }

    [StringLength(40, ErrorMessage = "A version is at most 40 characters.")]
    public string? FixedIn { get; init; }

    public IEnumerable<ValidationResult> Validate(ValidationContext validationContext)
    {
        if (Core.News.Technologies.Find(Technology!) is null)
        {
            yield return new($"Unknown technology slug '{Technology}'.", [nameof(Technology)]);
        }

        if (!Core.News.VersionRange.TryParse(VersionRange, out var range))
        {
            yield return new("A version range is like >=9.8.0 <10.3.0, with || between alternatives, or *.", [nameof(VersionRange)]);
        }
        else if (FixedIn is not null && range!.IsSatisfiedBy(FixedIn))
        {
            yield return new("The version that fixes it must be outside the range.", [nameof(FixedIn)]);
        }
    }
}

public sealed class SourceLinkWriteDto : IValidatableObject
{
    [Required(ErrorMessage = "Enter a title for the link.")]
    [StringLength(200, MinimumLength = 1, ErrorMessage = "A link title is 1 to 200 characters.")]
    public string? Title { get; init; }

    [Required(ErrorMessage = "Enter the link's address.")]
    [StringLength(2000, ErrorMessage = "A link is at most 2,000 characters.")]
    public string? Url { get; init; }

    public IEnumerable<ValidationResult> Validate(ValidationContext validationContext)
    {
        if (!Uri.TryCreate(Url, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps)
        {
            yield return new("A link is an absolute https address.", [nameof(Url)]);
        }
    }
}
